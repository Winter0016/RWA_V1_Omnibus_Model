'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { encodeFunctionData, createPublicClient, http, formatUnits } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { io } from 'socket.io-client';
import { GET_ALL_USERS, GET_ALL_TRANSACTIONS, GET_ALL_CONTRACTS } from '@/graphql/queries';
import { DTSLA_ADDRESS, DTSLA_ABI, USDC_ADDRESS, USDC_ABI } from '@/constants/contracts';

const truncateDecimals = (val: number | string, decimals: number = 6) => {
  if (!val) return '0';
  let str = val.toString();
  if (str.includes('.')) {
    const parts = str.split('.');
    if (parts[1].length > decimals) {
      parts[1] = parts[1].substring(0, decimals);
    }
    str = parts.join('.');
    str = str.replace(/\.?0+$/, '');
  }
  return str === '' ? '0' : str;
};

const CopyAddress = ({ address }: { address: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center space-x-2 inline-flex">
      <span>{address.slice(0, 6)}...{address.slice(-4)}</span>
      <button 
        onClick={handleCopy}
        className="text-zinc-500 hover:text-white transition-colors"
        title="Copy Address"
      >
        {copied ? (
          <span className="text-emerald-400 text-xs font-bold">✓</span>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
    </div>
  );
};

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<'users' | 'transactions' | 'contracts'>('users');
  const [whitelisting, setWhitelisting] = useState<string | null>(null);
  const [whitelistModal, setWhitelistModal] = useState<{ targetAddress: string, name: string } | null>(null);

  const [newContractAddress, setNewContractAddress] = useState('');
  const [newContractName, setNewContractName] = useState('');
  const [addingContract, setAddingContract] = useState(false);

  const { data: usersData, loading: usersLoading, error: usersError, refetch: refetchUsers } = useQuery<any>(GET_ALL_USERS, {
    fetchPolicy: 'network-only' // Always fetch fresh data for admin
  });

  const { data: txData, loading: txLoading, error: txError, refetch: refetchTxs } = useQuery<any>(GET_ALL_TRANSACTIONS, {
    fetchPolicy: 'network-only'
  });

  const { data: contractsData, loading: contractsLoading, error: contractsError, refetch: refetchContracts } = useQuery<any>(GET_ALL_CONTRACTS, {
    fetchPolicy: 'network-only'
  });



  // Listen for real-time global transaction updates
  useEffect(() => {
    const socket = io(process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000');

    socket.on('global_transaction_update', (data) => {
      console.log('Global transaction update received:', data);
      refetchTxs(); // Silently refetch the transactions list!
    });

    return () => {
      socket.disconnect();
    };
  }, [refetchTxs]);

  // Fetch true on-chain supply and USDC vault balance for Reconciliation
  const [chainSupply, setChainSupply] = useState<number | null>(null);
  const [chainUsdcBalance, setChainUsdcBalance] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [isTogglingPause, setIsTogglingPause] = useState(false);

  useEffect(() => {
    const fetchChainMetrics = async () => {
      try {
        const publicClient = createPublicClient({
          chain: arbitrumSepolia,
          transport: http('https://sepolia-rollup.arbitrum.io/rpc')
        });

        const [supply, usdcBal, paused] = await Promise.all([
          publicClient.readContract({
            address: DTSLA_ADDRESS as `0x${string}`,
            abi: DTSLA_ABI,
            functionName: 'totalSupply'
          }),
          publicClient.readContract({
            address: USDC_ADDRESS as `0x${string}`,
            abi: USDC_ABI,
            functionName: 'balanceOf',
            args: [DTSLA_ADDRESS]
          }),
          publicClient.readContract({
            address: DTSLA_ADDRESS as `0x${string}`,
            abi: DTSLA_ABI,
            functionName: 'paused'
          })
        ]);

        setChainSupply(Number(formatUnits(supply as bigint, 18)));
        setChainUsdcBalance(Number(formatUnits(usdcBal as bigint, 6))); // USDC uses 6 decimals
        setIsPaused(paused as boolean);
      } catch (err) {
        console.error("Failed to fetch chain metrics:", err);
      }
    };
    fetchChainMetrics();
  }, []);

  const { sendTransaction, ready, authenticated } = usePrivy();
  const { wallets } = useWallets();

  const executeWhitelist = async (targetAddress: string, status: boolean, isContract: boolean = false, name: string = '') => {
    try {
      setWhitelisting(targetAddress);

      if (!wallets || wallets.length === 0) {
        alert("Error: You do not have a connected wallet. Please connect your admin wallet to sign transactions.");
        return;
      }

      const activeWallet = wallets[0];

      const data = encodeFunctionData({
        abi: DTSLA_ABI,
        functionName: 'setWhitelist',
        args: [targetAddress as `0x${string}`, status]
      });

      console.log(`Executing whitelist for ${targetAddress} (Status: ${status})`);

      const publicClient = createPublicClient({
        chain: arbitrumSepolia,
        transport: http('https://sepolia-rollup.arbitrum.io/rpc')
      });

      // 1. Simulate the transaction first to catch any smart contract reverts BEFORE paying gas
      await publicClient.simulateContract({
        address: DTSLA_ADDRESS as `0x${string}`,
        abi: DTSLA_ABI,
        functionName: 'setWhitelist',
        args: [targetAddress as `0x${string}`, status],
        account: activeWallet.address as `0x${string}`
      });

      // Use the active wallet's provider directly to bypass Privy's ambiguity
      const provider = await activeWallet.getEthereumProvider();
      const txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: activeWallet.address,
          to: DTSLA_ADDRESS,
          data,
          chainId: '0x66EE6' // 421614 in hex
        }]
      });

      console.log("Whitelist tx hash:", txHash);
      alert(`Transaction submitted (Hash: ${txHash}). Waiting for confirmation...`);

      // Wait for the transaction to be mined and check if it succeeded
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`
      });

      if (receipt.status !== 'success') {
        throw new Error("Transaction reverted on-chain after passing simulation. This is usually due to a gas spike or race condition.");
      }

      // Indexer handles the database update via the WhitelistUpdated event automatically.
      // We trigger a refetch so the frontend updates without waiting for polling.
      if (isContract) {
        refetchContracts();
      } else {
        refetchUsers();
      }

      alert(`Successfully submitted whitelist transaction!\nTx Hash: ${txHash}`);
      setWhitelistModal(null);
    } catch (err: any) {
      console.error("Whitelist failed:", err);

      let parsedErrorMessage = err.message || typeof err === 'string' ? err : "Unknown error";
      const hexMatch = parsedErrorMessage?.match(/0x[a-fA-F0-9]{8,}/);
      if (hexMatch) {
        try {
          const { decodeErrorResult } = await import('viem');
          const decoded = decodeErrorResult({
            abi: DTSLA_ABI,
            data: hexMatch[0] as `0x${string}`
          });
          parsedErrorMessage = decoded.errorName === 'Error' && decoded.args
            ? `Smart Contract Revert: ${decoded.args[0]}`
            : `Smart Contract Revert: ${decoded.errorName}`;
        } catch (decodeErr) {
          console.log("Could not decode error:", decodeErr);
        }
      }

      alert(`Whitelist failed: ${parsedErrorMessage}`);
      return false;
    } finally {
      setWhitelisting(null);
    }
    return true;
  };

  const handleTogglePause = async () => {
    try {
      setIsTogglingPause(true);
      if (!wallets || wallets.length === 0) {
        alert("Error: You do not have a connected wallet. Please connect your admin wallet to sign transactions.");
        return;
      }

      const activeWallet = wallets[0];
      const functionName = isPaused ? 'unpause' : 'pause';

      const data = encodeFunctionData({
        abi: DTSLA_ABI,
        functionName: functionName,
      });

      // 1. Simulate the transaction first
      const publicClient = createPublicClient({
        chain: arbitrumSepolia,
        transport: http('https://sepolia-rollup.arbitrum.io/rpc')
      });

      await publicClient.simulateContract({
        address: DTSLA_ADDRESS as `0x${string}`,
        abi: DTSLA_ABI,
        functionName: functionName,
        account: activeWallet.address as `0x${string}`
      });

      // 2. Use the active wallet's provider directly
      const provider = await activeWallet.getEthereumProvider();
      const txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: activeWallet.address,
          to: DTSLA_ADDRESS,
          data,
          chainId: '0x66EE6'
        }]
      });

      alert(`Transaction submitted (Hash: ${txHash}). Waiting for confirmation...`);

      // 3. Wait for the transaction to be mined
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`
      });

      if (receipt.status !== 'success') {
        throw new Error("Transaction reverted on-chain after passing simulation. This is usually due to a gas spike or race condition.");
      }

      alert(`Successfully submitted ${functionName} transaction!\nTx Hash: ${txHash}`);
      setIsPaused(!isPaused);
    } catch (err: any) {
      console.error("Pause toggle failed:", err);

      let parsedErrorMessage = err.message || typeof err === 'string' ? err : "Unknown error";
      const hexMatch = parsedErrorMessage?.match(/0x[a-fA-F0-9]{8,}/);
      if (hexMatch) {
        try {
          const { decodeErrorResult } = await import('viem');
          const decoded = decodeErrorResult({
            abi: DTSLA_ABI,
            data: hexMatch[0] as `0x${string}`
          });
          parsedErrorMessage = decoded.errorName === 'Error' && decoded.args
            ? `Smart Contract Revert: ${decoded.args[0]}`
            : `Smart Contract Revert: ${decoded.errorName}`;
        } catch (decodeErr) {
          console.log("Could not decode error:", decodeErr);
        }
      }

      alert(`Toggle failed: ${parsedErrorMessage}`);
    } finally {
      setIsTogglingPause(false);
    }
  };

  const handleAddContract = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContractAddress || !newContractName) return;
    setAddingContract(true);
    const success = await executeWhitelist(newContractAddress, true, true, newContractName);
    if (success) {
      setNewContractAddress('');
      setNewContractName('');
    }
    setAddingContract(false);
  };

  if (!ready) {
    return <div className="min-h-screen bg-black flex items-center justify-center p-4 pt-24 text-zinc-500">Loading...</div>;
  }

  if (!authenticated || usersError?.message === 'UNAUTHORIZED' || txError?.message === 'UNAUTHORIZED') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-4 pt-24">
        <div className="bg-red-950/30 border border-red-900 rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-red-900/50 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">⛔</span>
          </div>
          <h1 className="text-2xl font-bold text-red-500 mb-2">Access Denied</h1>
          <p className="text-red-400/70">You do not have administrative privileges to view this page.</p>
        </div>
      </div>
    );
  }

  // Calculate Metrics from global transaction history
  const allTx = txData?.getAllTransactions || [];

  const totalMintedDTSLA = allTx
    .filter((tx: any) => tx.type === 'MINT' && tx.status === 'COMPLETED')
    .reduce((sum: number, tx: any) => sum + Number(tx.dtsla_amount || 0), 0);

  const totalRedeemedDTSLA = allTx
    .filter((tx: any) => tx.type === 'REDEEM' && tx.status === 'COMPLETED')
    .reduce((sum: number, tx: any) => sum + Number(tx.dtsla_amount || 0), 0);

  const currentDTSLASupply = totalMintedDTSLA - totalRedeemedDTSLA;

  const totalUSDCVolume = allTx
    .filter((tx: any) => tx.status === 'COMPLETED')
    .reduce((sum: number, tx: any) => {
      const amount = Number(tx.usdc_amount || 0);
      return tx.type === 'REDEEM' ? sum - amount : sum + amount;
    }, 0);

  return (
    <div className="flex-1 w-full flex flex-col items-center relative ">
      <main className="max-w-360 w-full mx-auto px-6 py-12 space-y-8 ">

        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight mb-2">Admin Dashboard</h1>
            <p className="text-zinc-400">Manage users, transactions, and smart contract whitelists.</p>
          </div>
          <button
            onClick={handleTogglePause}
            disabled={isTogglingPause}
            className={`px-6 py-2.5 font-bold rounded-xl transition-all shadow-lg flex items-center space-x-2 ${isPaused
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/20'
                : 'bg-red-500/10 text-red-400 border border-red-500/50 hover:bg-red-500/20'
              }`}
          >
            <span>{isTogglingPause ? 'Processing...' : (isPaused ? 'UNPAUSE PROTOCOL' : 'PAUSE PROTOCOL')}</span>
          </button>
        </div>

        {/* Global Metrics - Proof of Reserves */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
            <h3 className="text-sm font-medium text-zinc-400 mb-2">Total dTSLA Supply</h3>
            <div className="flex justify-between items-end">
              <div>
                <div className="text-xs text-zinc-500 mb-1">Database (Indexer)</div>
                <div className="text-2xl font-bold text-white font-mono">{truncateDecimals(currentDTSLASupply, 6)}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-blue-400/80 mb-1">Blockchain (Arbitrum)</div>
                <div className="text-2xl font-bold text-blue-400 font-mono">
                  {chainSupply !== null ? truncateDecimals(chainSupply, 6) : '...'}
                </div>
              </div>
            </div>
            {/* Reconciliation Status Indicator */}
            {chainSupply !== null && (
              <div className={`absolute top-0 right-0 w-full h-1 ${Math.abs(currentDTSLASupply - chainSupply) < 0.000001 ? 'bg-emerald-500' : 'bg-red-500'}`} />
            )}
          </div>
          <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 shadow-xl relative overflow-hidden flex flex-col justify-between">
            <h3 className="text-sm font-medium text-zinc-400 mb-2">Total USDC Vault Balance</h3>
            <div className="flex justify-between items-end">
              <div>
                <div className="text-xs text-zinc-500 mb-1">Database (Indexer)</div>
                <div className="text-2xl font-bold text-emerald-400 font-mono">
                  ${truncateDecimals(totalUSDCVolume, 6)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-blue-400/80 mb-1">Blockchain (Arbitrum)</div>
                <div className="text-2xl font-bold text-blue-400 font-mono">
                  {chainUsdcBalance !== null ? `$${truncateDecimals(chainUsdcBalance, 6)}` : '...'}
                </div>
              </div>
            </div>
            {/* Reconciliation Status Indicator */}
            {chainUsdcBalance !== null && (
              <div className={`absolute top-0 right-0 w-full h-1 ${Math.abs(totalUSDCVolume - chainUsdcBalance) < 0.000001 ? 'bg-emerald-500' : 'bg-red-500'}`} />
            )}
          </div>
          <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
            <h3 className="text-sm font-medium text-zinc-400 mb-1">Total Transactions</h3>
            <div className="text-3xl font-bold text-white font-mono">{allTx.length}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex space-x-1 bg-zinc-900/50 p-1 rounded-xl w-fit">
          <button
            onClick={() => setActiveTab('users')}
            className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'users'
              ? 'bg-zinc-800 text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
              }`}
          >
            Users Registry
          </button>
          <button
            onClick={() => setActiveTab('transactions')}
            className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'transactions'
              ? 'bg-zinc-800 text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
              }`}
          >
            Global Transactions
          </button>
          <button
            onClick={() => setActiveTab('contracts')}
            className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'contracts'
              ? 'bg-zinc-800 text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
              }`}
          >
            Protocol Contracts
          </button>
        </div>

        {/* Users Tab Content */}
        {activeTab === 'users' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl">
            {usersLoading ? (
              <div className="p-8 text-center text-zinc-500">Loading users...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-zinc-800/50 text-zinc-400 text-xs uppercase tracking-wider">
                      <th className="px-6 py-4 font-medium">User</th>
                      <th className="px-6 py-4 font-medium">Signer (EOA)</th>
                      <th className="px-6 py-4 font-medium">Smart Account</th>
                      <th className="px-6 py-4 font-medium">Role</th>
                      <th className="px-6 py-4 font-medium">Whitelisted</th>
                      <th className="px-6 py-4 font-medium">Whitelist Date</th>
                      <th className="px-6 py-4 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {usersData?.getAllUsers.map((u: any) => (
                      <tr key={u.id} className="hover:bg-zinc-800/20 transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-medium text-white">{u.name || 'Anonymous'}</div>
                          <div className="text-xs text-zinc-500">{u.email || 'No email'}</div>
                        </td>
                        <td className="px-6 py-4 font-mono text-sm text-zinc-300">
                          {u.signer_address ? <CopyAddress address={u.signer_address} /> : '-'}
                        </td>
                        <td className="px-6 py-4 font-mono text-sm text-zinc-300">
                          {u.wallet_address ? <CopyAddress address={u.wallet_address} /> : 'Pending...'}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2.5 py-1 text-xs rounded-full font-medium ${u.role === 'admin' ? 'bg-purple-500/20 text-purple-400' : 'bg-zinc-800 text-zinc-400'
                            }`}>
                            {u.role.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2.5 py-1 text-xs rounded-full font-medium ${u.is_whitelisted ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                            {u.is_whitelisted ? 'YES' : 'NO'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs text-zinc-400">
                          {u.whitelist_updated_at ? new Date(Number(u.whitelist_updated_at)).toLocaleString() : '-'}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            disabled={!u.wallet_address || whitelisting === u.wallet_address}
                            onClick={() => setWhitelistModal({ targetAddress: u.wallet_address, name: u.name || 'User' })}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${whitelisting === u.wallet_address
                              ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                              : !u.wallet_address
                                ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                                : 'bg-blue-600 hover:bg-blue-500 text-white'
                              }`}
                          >
                            {whitelisting === u.wallet_address ? 'Processing...' : 'Manage'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Transactions Tab Content */}
        {activeTab === 'transactions' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl">
            {txLoading ? (
              <div className="p-8 text-center text-zinc-500">Loading transactions...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-zinc-800/50 text-zinc-400 text-xs uppercase tracking-wider">
                      <th className="px-6 py-4 font-medium">Type</th>
                      <th className="px-6 py-4 font-medium">User Wallet</th>
                      <th className="px-6 py-4 font-medium">USDC</th>
                      <th className="px-6 py-4 font-medium">dTSLA</th>
                      <th className="px-6 py-4 font-medium">Status</th>
                      <th className="px-6 py-4 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {txData?.getAllTransactions.map((tx: any) => (
                      <tr key={tx.id} className="hover:bg-zinc-800/20 transition-colors">
                        <td className="px-6 py-4">
                          <span className={`font-medium ${tx.type === 'MINT' ? 'text-green-400' : 'text-red-400'}`}>
                            {tx.type}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-mono text-sm text-zinc-300">
                          {tx.wallet_address ? <CopyAddress address={tx.wallet_address} /> : 'Unknown'}
                        </td>
                        <td className="px-6 py-4 font-mono text-white">${tx.usdc_amount ? truncateDecimals(tx.usdc_amount) : '-'}</td>
                        <td className="px-6 py-4 font-mono text-zinc-300">
                          {tx.dtsla_amount ? truncateDecimals(tx.dtsla_amount) : '-'}
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-xs px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
                            {tx.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-zinc-500">
                          {new Date(Number(tx.created_at)).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Contracts Tab Content */}
        {activeTab === 'contracts' && (
          <div className="space-y-6 w-full">
            {/* Add Contract Form */}
            <form onSubmit={handleAddContract} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl flex gap-4 items-end">
              <div className="flex-1">
                <label className="block text-sm font-medium text-zinc-400 mb-2">Protocol Name</label>
                <input
                  type="text"
                  value={newContractName}
                  onChange={(e) => setNewContractName(e.target.value)}
                  placeholder="e.g. Uniswap V3 Router"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
                  required
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-zinc-400 mb-2">Contract Address</label>
                <input
                  type="text"
                  value={newContractAddress}
                  onChange={(e) => setNewContractAddress(e.target.value)}
                  placeholder="0x..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-mono text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={addingContract || whitelisting !== null}
                className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-xl transition-colors disabled:opacity-50 h-11.5"
              >
                {addingContract ? 'Adding...' : 'Add & Whitelist'}
              </button>
            </form>

            {/* Contracts Table */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl">
              {contractsLoading ? (
                <div className="p-8 text-center text-zinc-500">Loading contracts...</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-zinc-800/50 text-zinc-400 text-xs uppercase tracking-wider">
                        <th className="px-6 py-4 font-medium">Protocol Name</th>
                        <th className="px-6 py-4 font-medium">Contract Address</th>
                        <th className="px-6 py-4 font-medium">Whitelisted</th>
                        <th className="px-6 py-4 font-medium">Date Added</th>
                        <th className="px-6 py-4 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {contractsData?.getAllContracts.map((c: any) => (
                        <tr key={c.id} className="hover:bg-zinc-800/20 transition-colors">
                          <td className="px-6 py-4 font-medium text-white">{c.name}</td>
                          <td className="px-6 py-4 font-mono text-sm text-zinc-300">
                            <CopyAddress address={c.contract_address} />
                          </td>
                          <td className="px-6 py-4">
                            <span className={`px-2.5 py-1 text-xs rounded-full font-medium ${c.is_whitelisted ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                              {c.is_whitelisted ? 'YES' : 'NO'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-xs text-zinc-400">
                            {c.created_at ? new Date(Number(c.created_at)).toLocaleString() : '-'}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <button
                              disabled={whitelisting === c.contract_address}
                              onClick={() => executeWhitelist(c.contract_address, !c.is_whitelisted, true, c.name)}
                              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${whitelisting === c.contract_address
                                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                                : c.is_whitelisted
                                  ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400'
                                  : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400'
                                }`}
                            >
                              {whitelisting === c.contract_address
                                ? 'Processing...'
                                : c.is_whitelisted ? 'Revoke' : 'Approve'}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {(!contractsData?.getAllContracts || contractsData.getAllContracts.length === 0) && (
                        <tr>
                          <td colSpan={5} className="px-6 py-8 text-center text-zinc-500">
                            No protocol contracts tracked yet. Add one above.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Whitelist Modal */}
      {whitelistModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[#0B0F19] border border-[#1E293B] rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
            <button
              onClick={() => setWhitelistModal(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors"
            >
              ✕
            </button>

            <h2 className="text-xl font-semibold text-white mb-2">Manage Whitelist</h2>
            <p className="text-slate-400 text-sm mb-6">
              Update whitelist status for <strong>{whitelistModal.name}</strong> 
              <span className="ml-2 inline-block"><CopyAddress address={whitelistModal.targetAddress} /></span>.
            </p>

            <div className="flex gap-4">
              <button
                onClick={() => executeWhitelist(whitelistModal.targetAddress, true, false, '')}
                disabled={whitelisting === whitelistModal.targetAddress}
                className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
              >
                Approve (True)
              </button>
              <button
                onClick={() => executeWhitelist(whitelistModal.targetAddress, false, false, '')}
                disabled={whitelisting === whitelistModal.targetAddress}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
              >
                Revoke (False)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
