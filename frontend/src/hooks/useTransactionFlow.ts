"use client";

import { useState, useEffect, useRef } from 'react';
import { useApolloClient } from '@apollo/client/react';
import { useWallets } from '@privy-io/react-auth';
import { io, Socket } from 'socket.io-client';
import { encodeFunctionData, parseUnits } from 'viem';
import { useGaslessTx } from './useGaslessTx';
import { DTSLA_ADDRESS, DTSLA_ABI } from '../constants/contracts';
import { RESERVE_MINT_POWER, GET_CLAIM_SIGNATURE, GET_CLAIM_USDC_SIGNATURE, GET_REFUND_SIGNATURE, CANCEL_PENDING_TRANSACTION } from '../graphql/mutations';

export type TxState =
  | 'IDLE'
  | 'REQUESTING_QUOTE'
  | 'AWAITING_DEPOSIT_TX'
  | 'PROCESSING_OFFCHAIN'
  | 'AWAITING_CLAIM_TX'
  | 'SUCCESS'
  | 'ERROR'
  | 'CANCELED_BY_ADMIN';

export function useTransactionFlow() {
  const [state, setState] = useState<TxState>('IDLE');
  const [txType, setTxType] = useState<'MINT'|'REDEEM'|'REFUND'>('MINT');
  const processedTxRef = useRef<Set<string>>(new Set());

  const { wallets } = useWallets();
  const activeWallet = wallets[0];
  const activeWalletAddress = activeWallet?.address;

  const apolloClient = useApolloClient();
  const { smartAccount, sendGaslessTransaction } = useGaslessTx();

  // Initialize WebSocket connection and Listeners in one highly-optimized effect
  useEffect(() => {
    if (!smartAccount?.address) return;

    const newSocket = io(process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000');

    newSocket.on('connect', () => {
      console.log('Connected to WebSocket server');
      newSocket.emit('join_room', smartAccount.address);
    });

    const handleTransactionReady = async (wsData: any) => {
      console.log("Central WebSocket listener caught event:", wsData);
      
      if (processedTxRef.current.has(wsData.transactionHash)) {
        console.log("Ignoring duplicate websocket event for:", wsData.transactionHash);
        return;
      }
      processedTxRef.current.add(wsData.transactionHash);

      if (wsData.status === 'READY_TO_CLAIM') {
        setTimeout(async () => {
          await resumeClaim(wsData.transactionHash);
        }, 3000);
      } else if (wsData.status === 'READY_TO_CLAIM_USDC') {
        setTimeout(async () => {
          await resumeRedeem(wsData.transactionHash);
        }, 3000);
      } else if (wsData.status === 'FAILED' || wsData.status === 'CANCELED_BY_ADMIN') {
        if (wsData.reason) {
          alert(`Trade Rejected by Broker: ${wsData.reason}\n\nInitiating automatic on-chain refund...`);
        }
        setTimeout(async () => {
          await resumeRefund(wsData.transactionHash);
        }, 3000);
      }
    };

    const handleTransactionUpdate = (wsData: any) => {
      console.log("Transaction update received:", wsData);
      // Directly tell Apollo to refetch active queries instead of triggering a React state re-render!
      apolloClient.refetchQueries({
        include: "active",
      });
    };

    newSocket.on('transaction_ready', handleTransactionReady);
    newSocket.on('transaction_update', handleTransactionUpdate);

    return () => {
      newSocket.off('transaction_ready', handleTransactionReady);
      newSocket.off('transaction_update', handleTransactionUpdate);
      newSocket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smartAccount?.address]); // We deliberately exclude resumeClaim/resumeRedeem to avoid infinite re-renders

  const initiateMint = async (usdcAmount: string) => {
    if (!activeWalletAddress) return;
    setTxType('MINT');
    setState('REQUESTING_QUOTE');

    try {
      if (!smartAccount) throw new Error("Smart Account not initialized");

      // 1. Get Mint Quote from Backend
      const { data } = await apolloClient.mutate({
        mutation: RESERVE_MINT_POWER,
        variables: {
          usdcAmount: usdcAmount,
          walletAddress: smartAccount.address // The Smart Account is msg.sender!
        }
      });

      const { timestamp, signature } = (data as any).reserveMintPower;

      // Convert USDC (USDC always uses 6 decimals)
      const usdcAmountWei = parseUnits(usdcAmount, 6);

      setState('AWAITING_DEPOSIT_TX');

      // 2. Prepare Deposit Transaction
      const depositCallData = encodeFunctionData({
        abi: DTSLA_ABI,
        functionName: 'depositForMint',
        args: [usdcAmountWei, BigInt(timestamp), signature as `0x${string}`]
      });

      // 2.5 Prepare Approve Transaction for the dTSLA Contract
      // The dTSLA contract uses transferFrom, so it needs permission to take the USDC!
      const { erc20Abi } = await import('viem');
      const { USDC_ADDRESS } = await import('../constants/contracts');

      const approveContractCallData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [DTSLA_ADDRESS, usdcAmountWei]
      });

      // 3. Send Gasless Transaction Batch (Approve + Deposit)
      await sendGaslessTransaction(
        [USDC_ADDRESS as `0x${string}`, DTSLA_ADDRESS],
        [BigInt(0), BigInt(0)],
        [approveContractCallData, depositCallData]
      );

      setState('PROCESSING_OFFCHAIN');

      // We now rely on the centralized useEffect listener to catch the event
      // whenever it arrives, ensuring we don't drop concurrent events!
    } catch (error: any) {
      console.error("Mint initiation failed:", error);
      alert(`Transaction failed: ${error.message || "Protocol might be paused."}`);
      setState('IDLE');
    }
  };

  const resumeClaim = async (transactionHash: string) => {
    setState('AWAITING_CLAIM_TX');
    try {
      // 5. Get Claim Signature
      const claimRes = await apolloClient.query({
        query: GET_CLAIM_SIGNATURE,
        variables: {
          transactionHash: transactionHash
        },
        fetchPolicy: 'network-only' // Ensure we don't hit cache
      });

      const claimData = (claimRes.data as any).getClaimSignature;

      const usdcConsumedWei = parseUnits(claimData.usdcAmount, 6);
      const dTslaAmountWei = parseUnits(claimData.dTslaAmount, 18);

      // 6. Encode Smart Contract Data for claimMint
      const claimCallData = encodeFunctionData({
        abi: DTSLA_ABI,
        functionName: 'claimMint',
        args: [usdcConsumedWei, dTslaAmountWei, BigInt(claimData.timestamp), claimData.signature as `0x${string}`]
      });

      // 7. Send Final Gasless Transaction
      await sendGaslessTransaction(
        [DTSLA_ADDRESS],
        [0],
        [claimCallData]
      );

      setState('SUCCESS');
    } catch (err: any) {
      console.error("Failed to resume claim:", err);
      alert(`Transaction failed: ${err.message || "Protocol might be paused."}`);
      setState('IDLE');
    }
  };

  const initiateRedeem = async (dTslaAmount: string) => {
    if (!activeWalletAddress) return;
    setTxType('REDEEM');
    setState('AWAITING_DEPOSIT_TX'); // Reusing state for the on-chain lock

    try {
      if (!smartAccount) throw new Error("Smart Account not initialized");

      const dTslaAmountWei = parseUnits(dTslaAmount, 18);

      const requestRedeemCallData = encodeFunctionData({
        abi: DTSLA_ABI,
        functionName: 'requestRedeem',
        args: [dTslaAmountWei]
      });

      await sendGaslessTransaction(
        [DTSLA_ADDRESS],
        [BigInt(0)],
        [requestRedeemCallData]
      );

      setState('PROCESSING_OFFCHAIN');

      // We now rely on the centralized useEffect listener to catch the event
      // whenever it arrives, ensuring we don't drop concurrent events!
    } catch (error: any) {
      console.error("Failed to initiate redeem:", error);
      alert(`Transaction failed: ${error.message || "Protocol might be paused."}`);
      setState('IDLE');
    }
  };

  const resumeRedeem = async (transactionHash: string) => {
    setState('AWAITING_CLAIM_TX');
    try {
      const claimRes = await apolloClient.query({
        query: GET_CLAIM_USDC_SIGNATURE,
        variables: {
          transactionHash: transactionHash
        },
        fetchPolicy: 'network-only'
      });

      const claimData = (claimRes.data as any).getClaimUSDCSignature;

      const usdcAmountWei = parseUnits(claimData.usdcAmount, 6);
      const dTslaAmountWei = parseUnits(claimData.dTslaAmount, 18);

      const redeemCallData = encodeFunctionData({
        abi: DTSLA_ABI,
        functionName: 'redeem',
        args: [dTslaAmountWei, usdcAmountWei, BigInt(claimData.timestamp), claimData.signature as `0x${string}`]
      });

      await sendGaslessTransaction(
        [DTSLA_ADDRESS],
        [0],
        [redeemCallData]
      );

      setState('SUCCESS');
    } catch (err: any) {
      console.error("Failed to resume redeem:", err);
      alert(`Transaction failed: ${err.message || "Protocol might be paused."}`);
      setState('IDLE');
    }
  };

  const resumeRefund = async (transactionHash: string) => {
    setTxType('REFUND');
    setState('AWAITING_CLAIM_TX');
    try {
      const refundRes = await apolloClient.query({
        query: GET_REFUND_SIGNATURE,
        variables: {
          transactionHash: transactionHash
        },
        fetchPolicy: 'network-only'
      });

      const refundData = (refundRes.data as any).getRefundSignature;
      const usdcAmountWei = parseUnits(refundData.usdcAmount, 6);
      const dTslaAmountWei = parseUnits(refundData.dTslaAmount, 18);

      let refundCallData;
      if (dTslaAmountWei > BigInt(0)) {
        refundCallData = encodeFunctionData({
          abi: DTSLA_ABI,
          functionName: 'cancelRedeem',
          args: [dTslaAmountWei, BigInt(refundData.timestamp), refundData.signature as `0x${string}`]
        });
      } else {
        refundCallData = encodeFunctionData({
          abi: DTSLA_ABI,
          functionName: 'cancelMint',
          args: [usdcAmountWei, BigInt(refundData.timestamp), refundData.signature as `0x${string}`]
        });
      }

      await sendGaslessTransaction(
        [DTSLA_ADDRESS],
        [0],
        [refundCallData]
      );

      setState('SUCCESS');
    } catch (err: any) {
      console.error("Failed to resume refund:", err);
      alert(`Transaction failed: ${err.message || "Protocol might be paused."}`);
      setState('IDLE');
    }
  };

  const cancelPendingTx = async (transactionHash: string) => {
    setTxType('REFUND');
    setState('AWAITING_CLAIM_TX'); // Similar to refund state
    try {
      if (!smartAccount) throw new Error("Smart Account not initialized");

      const cancelRes = await apolloClient.mutate({
        mutation: CANCEL_PENDING_TRANSACTION,
        variables: {
          transactionHash: transactionHash
        }
      });

      const refundData = (cancelRes.data as any).cancelPendingTransaction;
      const usdcAmountWei = parseUnits(refundData.usdcAmount, 6);
      const dTslaAmountWei = parseUnits(refundData.dTslaAmount, 18);

      let refundCallData;
      if (dTslaAmountWei > BigInt(0)) {
        refundCallData = encodeFunctionData({
          abi: DTSLA_ABI,
          functionName: 'cancelRedeem',
          args: [dTslaAmountWei, BigInt(refundData.timestamp), refundData.signature as `0x${string}`]
        });
      } else {
        refundCallData = encodeFunctionData({
          abi: DTSLA_ABI,
          functionName: 'cancelMint',
          args: [usdcAmountWei, BigInt(refundData.timestamp), refundData.signature as `0x${string}`]
        });
      }

      await sendGaslessTransaction(
        [DTSLA_ADDRESS],
        [0],
        [refundCallData]
      );

      setState('SUCCESS');
    } catch (err: any) {
      console.error("Failed to cancel transaction:", err);
      alert(`Failed to cancel transaction: ${err.message}`);
      setState('IDLE');
    }
  };

  return { state, setState, initiateMint, resumeClaim, initiateRedeem, resumeRedeem, resumeRefund, cancelPendingTx, txType };
}
