const pool = require('./db');
const { getAvailableFiat, getTslaPrice } = require('./alpaca');
const { redisClient } = require('./redis');
const { privateKeyToAccount } = require('viem/accounts');
const { keccak256, encodePacked, parseEther, parseUnits } = require('viem');

const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY_ARBITRUM;
// The oracle account object
const oracleAccount = privateKeyToAccount(`0x${ORACLE_PRIVATE_KEY}`);

const resolvers = {
  Query: {
    userBySigner: async (_, { signer_address }, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      const { rows } = await pool.query(
        'SELECT * FROM users WHERE signer_address = $1',
        [signer_address]
      );
      const requestedUser = rows[0] || null;
      if (!requestedUser) return null;

      // Security check: only allow querying own profile unless caller is admin
      if (requestedUser.privy_id !== context.user.privyUserId) {
        const callerRes = await pool.query('SELECT role FROM users WHERE privy_id = $1', [context.user.privyUserId]);
        if (callerRes.rows[0]?.role !== 'admin') {
          throw new Error("UNAUTHORIZED: You can only query your own profile");
        }
      }
      return requestedUser;
    },
    getClaimSignature: async (_, { transactionHash }, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      // 1. Fetch the transaction
      const txRes = await pool.query('SELECT * FROM transactions WHERE blockchain_tx = $1', [transactionHash]);
      if (txRes.rows.length === 0) {
        throw new Error("Transaction not found");
      }

      const tx = txRes.rows[0];

      // 2. Ensure it's ready to claim
      if (tx.status !== 'READY_TO_CLAIM') {
        throw new Error(`Transaction is not ready to claim. Current status: ${tx.status}`);
      }

      // 3. Fetch the user's wallet address
      const userRes = await pool.query('SELECT wallet_address FROM users WHERE id = $1', [tx.user_id]);
      if (userRes.rows.length === 0) {
        throw new Error("User not found for this transaction");
      }
      const wallet_address = userRes.rows[0].wallet_address;

      if (!wallet_address) {
        throw new Error("User does not have a connected wallet address");
      }

      // 4. Check cache first to prevent TOCTOU replay attacks
      const cachedSig = await redisClient.get(`ClaimSig:${transactionHash}`);
      if (cachedSig) return JSON.parse(cachedSig);

      const lockKey = `Lock:${transactionHash}`;
      const acquired = await redisClient.setNX(lockKey, "1");
      if (!acquired) throw new Error("Transaction is currently being processed. Please try again.");
      await redisClient.expire(lockKey, 10);

      try {


        // 5. Generate Signature
        const timestamp = Math.floor(Date.now() / 1000);

        // keccak256(abi.encodePacked(msg.sender, usdcConsumed, dTslaAmount, timestamp, "claimMint"))
        const messageHash = keccak256(
          encodePacked(
            ['address', 'uint256', 'uint256', 'uint256', 'string'],
            [
              wallet_address,
              parseUnits(tx.usdc_amount.toString(), 6), // USDC uses 6 decimals
              parseUnits(tx.dtsla_amount.toString(), 18),
              BigInt(timestamp),
              "claimMint"
            ]
          )
        );

        const signature = await oracleAccount.signMessage({ message: { raw: messageHash } });

        const result = {
          usdcAmount: tx.usdc_amount,
          dTslaAmount: tx.dtsla_amount,
          timestamp,
          signature
        };

        await redisClient.setEx(`ClaimSig:${transactionHash}`, 280, JSON.stringify(result));
        return result;
      } finally {
        await redisClient.del(lockKey);
      }
    },
    getClaimUSDCSignature: async (_, { transactionHash }, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      // 1. Fetch the transaction
      const txRes = await pool.query('SELECT * FROM transactions WHERE blockchain_tx = $1', [transactionHash]);
      if (txRes.rows.length === 0) {
        throw new Error("Transaction not found");
      }

      const tx = txRes.rows[0];

      // 2. Ensure it's ready to claim
      if (tx.status !== 'READY_TO_CLAIM_USDC') {
        throw new Error(`Transaction is not ready to claim. Current status: ${tx.status}`);
      }

      // 3. Fetch the user's wallet address
      const userRes = await pool.query('SELECT wallet_address FROM users WHERE id = $1', [tx.user_id]);
      if (userRes.rows.length === 0) {
        throw new Error("User not found for this transaction");
      }
      const wallet_address = userRes.rows[0].wallet_address;

      if (!wallet_address) {
        throw new Error("User does not have a connected wallet address");
      }

      // 4. Check cache first to prevent TOCTOU replay attacks
      const cachedSig = await redisClient.get(`ClaimUSDCSig:${transactionHash}`);
      if (cachedSig) return JSON.parse(cachedSig);

      const lockKey = `Lock:${transactionHash}`;
      const acquired = await redisClient.setNX(lockKey, "1");
      if (!acquired) throw new Error("Transaction is currently being processed. Please try again.");
      await redisClient.expire(lockKey, 10);

      try {


        // 5. Generate Signature
        const timestamp = Math.floor(Date.now() / 1000);

        // keccak256(abi.encodePacked(msg.sender, dTslaAmount, usdcAmount, timestamp, "redeem"))
        const messageHash = keccak256(
          encodePacked(
            ['address', 'uint256', 'uint256', 'uint256', 'string'],
            [
              wallet_address,
              parseUnits(tx.dtsla_amount.toString(), 18),
              parseUnits(tx.usdc_amount.toString(), 6), // USDC uses 6 decimals
              BigInt(timestamp),
              "redeem"
            ]
          )
        );

        const signature = await oracleAccount.signMessage({ message: { raw: messageHash } });

        const result = {
          usdcAmount: tx.usdc_amount,
          dTslaAmount: tx.dtsla_amount,
          timestamp,
          signature
        };

        await redisClient.setEx(`ClaimUSDCSig:${transactionHash}`, 280, JSON.stringify(result));
        return result;
      } finally {
        await redisClient.del(lockKey);
      }
    },
    getRefundSignature: async (_, { transactionHash }, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      // 1. Fetch the transaction
      const txRes = await pool.query('SELECT * FROM transactions WHERE blockchain_tx = $1', [transactionHash]);
      if (txRes.rows.length === 0) {
        throw new Error("Transaction not found");
      }

      const tx = txRes.rows[0];

      // 2. Ensure it's FAILED, CANCELED_BY_ADMIN, or CANCELED_BY_USER
      if (tx.status !== 'FAILED' && tx.status !== 'CANCELED_BY_ADMIN' && tx.status !== 'CANCELED_BY_USER') {
        throw new Error(`Transaction is not FAILED or CANCELED. Cannot refund. Current status: ${tx.status}`);
      }

      // 2.5. Check cache to prevent TOCTOU replay attacks
      const cachedSig = await redisClient.get(`RefundSig:${transactionHash}`);
      if (cachedSig) return JSON.parse(cachedSig);

      const lockKey = `Lock:${transactionHash}`;
      const acquired = await redisClient.setNX(lockKey, "1");
      if (!acquired) throw new Error("Transaction is currently being processed. Please try again.");
      await redisClient.expire(lockKey, 10);

      try {


        // 3. Fetch the user's wallet address
        const userRes = await pool.query('SELECT wallet_address FROM users WHERE id = $1', [tx.user_id]);
        if (userRes.rows.length === 0) {
          throw new Error("User not found for this transaction");
        }
        const wallet_address = userRes.rows[0].wallet_address;

        if (!wallet_address) {
          throw new Error("User does not have a connected wallet address");
        }

        // 4. Generate Signature based on Type
        const timestamp = Math.floor(Date.now() / 1000);
        let messageHash;

        if (tx.type === 'MINT') {
          // keccak256(abi.encodePacked(msg.sender, usdcAmount, timestamp, "cancelMint"))
          messageHash = keccak256(
            encodePacked(
              ['address', 'uint256', 'uint256', 'string'],
              [
                wallet_address,
                parseUnits(tx.usdc_amount.toString(), 6), // USDC uses 6 decimals
                BigInt(timestamp),
                "cancelMint"
              ]
            )
          );
        } else if (tx.type === 'REDEEM') {
          // keccak256(abi.encodePacked(msg.sender, dTslaAmount, timestamp, "cancelRedeem"))
          messageHash = keccak256(
            encodePacked(
              ['address', 'uint256', 'uint256', 'string'],
              [
                wallet_address,
                parseUnits(tx.dtsla_amount.toString(), 18),
                BigInt(timestamp),
                "cancelRedeem"
              ]
            )
          );
        } else {
          throw new Error("Unknown transaction type");
        }

        // Sign the raw hash
        const signature = await oracleAccount.signMessage({ message: { raw: messageHash } });

        const result = {
          usdcAmount: tx.usdc_amount,
          dTslaAmount: tx.dtsla_amount,
          timestamp,
          signature
        };

        // Cache it for 4 minutes and 40 secs
        await redisClient.setEx(`RefundSig:${transactionHash}`, 280, JSON.stringify(result));

        return result;
      } finally {
        await redisClient.del(lockKey);
      }
    },
    getUserTransactions: async (_, __, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");

      // Look up the database UUID using the secure Privy ID from the JWT
      const userRes = await pool.query('SELECT id FROM users WHERE privy_id = $1', [context.user.privyUserId]);
      if (userRes.rows.length === 0) throw new Error("User profile not found in database");

      const dbUserId = userRes.rows[0].id;

      const { rows } = await pool.query(
        'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
        [dbUserId]
      );
      return rows;
    },
    getAllUsers: async (_, __, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      const userRes = await pool.query('SELECT role FROM users WHERE privy_id = $1', [context.user.privyUserId]);
      if (userRes.rows.length === 0 || userRes.rows[0].role !== 'admin') {
        throw new Error("UNAUTHORIZED Admin Only");
      }

      const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
      return rows;
    },
    getAllTransactions: async (_, __, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      const userRes = await pool.query('SELECT role FROM users WHERE privy_id = $1', [context.user.privyUserId]);
      if (userRes.rows.length === 0 || userRes.rows[0].role !== 'admin') {
        throw new Error("UNAUTHORIZED");
      }

      const { rows } = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC');
      return rows;
    },
    getAllContracts: async (_, __, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      const userRes = await pool.query('SELECT role FROM users WHERE privy_id = $1', [context.user.privyUserId]);
      if (userRes.rows.length === 0 || userRes.rows[0].role !== 'admin') {
        throw new Error("UNAUTHORIZED");
      }

      const { rows } = await pool.query('SELECT * FROM whitelisted_contracts ORDER BY created_at DESC');
      return rows;
    },
    getTslaPrice: async () => {
      try {
        const price = await getTslaPrice();
        return price;
      } catch (err) {
        console.error("Error fetching TSLA price in resolver:", err);
        return 0.0;
      }
    }
  },
  Mutation: {
    reserveMintPower: async (_, { usdcAmount, wallet_address }, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      if (!wallet_address) throw new Error("Wallet address is required");

      // SECURITY PATCH: Verify the requested wallet_address belongs to the logged-in user
      const userRes = await pool.query('SELECT wallet_address FROM users WHERE privy_id = $1', [context.user.privyUserId]);
      if (userRes.rows.length === 0) throw new Error("User profile not found in database");

      const realWallet = userRes.rows[0].wallet_address;
      if (!realWallet || realWallet.toLowerCase() !== wallet_address.toLowerCase()) {
        throw new Error(`UNAUTHORIZED: You are trying to mint to a wallet you don't own (${wallet_address})`);
      }

      // 1. Get real cash balance from Alpaca
      const availableFiat = await getAvailableFiat();

      // 2. Atomically reserve the fiat first (Solves the Race Condition!)
      const parsedUsdc = parseFloat(usdcAmount);
      const newReservedFiat = await redisClient.incrByFloat('alpaca:reserved_buying_power', parsedUsdc);
      
      const previousReservedFiat = newReservedFiat - parsedUsdc;
      const trulyAvailable = availableFiat - previousReservedFiat;

      if (trulyAvailable < parsedUsdc) {
        // Rollback the reservation since it exceeds buying power
        await redisClient.incrByFloat('alpaca:reserved_buying_power', -parsedUsdc);
        throw new Error(`Insufficient Buying Power. Available: $${trulyAvailable.toFixed(2)}`);
      }

      // 3. Generate Oracle Signature (The UUID)
      const timestamp = Math.floor(Date.now() / 1000);

      const messageHash = keccak256(
        encodePacked(
          ['address', 'uint256', 'uint256', 'string'],
          [
            wallet_address,
            parseUnits(usdcAmount.toString(), 6),
            BigInt(timestamp),
            "depositForMint"
          ]
        )
      );

      const signature = await oracleAccount.signMessage({ message: { raw: messageHash } });

      // 4. Save to Redis using the Signature as the key with a 5-minute TTL!
      // (The global counter was already incremented atomically above)
      await redisClient.setEx(`Lock:${signature}`, 300, usdcAmount.toString());

      console.log(`🔒 Reserved $${usdcAmount} (Lock TTL: 5m)`);

      // 5. Fallback setTimeout to decrement the global counter if the Lock expires
      // (Since Redis keys auto-delete, the Lock itself is safe, but we need to fix the global math)
      setTimeout(async () => {
        const status = await redisClient.get(`Lock:${signature}`);
        if (status !== "COMPLETED") { // If it timed out or is still PENDING...
          await redisClient.incrByFloat('alpaca:reserved_buying_power', -usdcAmount);
          console.log(`🔓 5-Min Timeout: Released $${usdcAmount} back to global pool.`);
        }
        await redisClient.del(`Lock:${signature}`); // Clean up
      }, 5 * 60 * 1000);

      return {
        usdcAmount,
        dTslaAmount: 0, // Not known yet
        timestamp,
        signature
      };
    },
    addUser: async (_, { email, name, signer_address, wallet_address }, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      const privy_id = context.user.privyUserId;

      // SECURITY PATCH: Verify the user actually owns the signer_address they are trying to inject!
      const privyUser = await context.privy.getUser(privy_id);

      // Extract all verified wallet addresses attached to this Privy account
      const verifiedWallets = privyUser.linkedAccounts
        .filter(a => a.type === 'wallet')
        .map(a => a.address.toLowerCase());

      if (!verifiedWallets.includes(signer_address.toLowerCase())) {
        throw new Error("HACKER DETECTED: You do not own this wallet address!");
      }

      // 1. Check if user already exists using ONLY the unforgeable privy_id
      const check = await pool.query('SELECT * FROM users WHERE privy_id = $1', [privy_id]);
      if (check.rows.length > 0) {
        const existingUser = check.rows[0];

        if (wallet_address && existingUser.wallet_address !== wallet_address) {
          const update = await pool.query('UPDATE users SET wallet_address = $1 WHERE id = $2 RETURNING *', [wallet_address, existingUser.id]);
          console.log(`🔄 Updated User Wallet in DB: ${existingUser.name}`);
          return update.rows[0];
        }
        return existingUser;
      }

      // 1.5. Legacy User Account Takeover Prevention
      // If we got here, they don't have a row with their privy_id.
      // We check if a row exists with their signer_address (a legacy account).
      // Since we ALREADY cryptographically verified they own this signer_address above,
      // it is mathematically safe to backfill their new privy_id to this row!
      const legacyCheck = await pool.query('SELECT * FROM users WHERE signer_address = $1 AND privy_id IS NULL', [signer_address]);
      if (legacyCheck.rows.length > 0) {
        const legacyUser = legacyCheck.rows[0];
        await pool.query('UPDATE users SET privy_id = $1 WHERE id = $2', [privy_id, legacyUser.id]);
        console.log(`🔄 SECURELY backfilled privy_id for legacy user: ${legacyUser.name}`);

        if (wallet_address && legacyUser.wallet_address !== wallet_address) {
          await pool.query('UPDATE users SET wallet_address = $1 WHERE id = $2', [wallet_address, legacyUser.id]);
        }
        return { ...legacyUser, privy_id, wallet_address: wallet_address || legacyUser.wallet_address };
      }

      // 2. Insert new user with their unforgeable privy_id
      const { rows } = await pool.query(
        `INSERT INTO users (email, name, signer_address, wallet_address, privy_id) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING *`,
        [email, name, signer_address, wallet_address, privy_id]
      );

      console.log(`🎉 New User Created in DB: ${name}`);
      return rows[0];
    },

    cancelPendingTransaction: async (_, { transactionHash }, context) => {
      if (!context.user) throw new Error("UNAUTHENTICATED");
      const { alpaca } = require('./alpaca');

      // 1. Fetch transaction
      const txRes = await pool.query('SELECT * FROM transactions WHERE blockchain_tx = $1', [transactionHash]);
      if (txRes.rows.length === 0) {
        throw new Error("Transaction not found");
      }
      const tx = txRes.rows[0];

      // 2. Authorize: Make sure this user owns the transaction
      const userRes = await pool.query('SELECT privy_id FROM users WHERE id = $1', [tx.user_id]);
      if (userRes.rows.length === 0 || userRes.rows[0].privy_id !== context.user.privyUserId) {
        throw new Error("UNAUTHORIZED: You do not own this transaction");
      }

      // 3. Ensure it's PENDING
      if (tx.status !== 'PENDING_ALPACA') {
        throw new Error(`Cannot cancel transaction. Status is currently: ${tx.status}`);
      }

      // 4. Check with Alpaca if it can be canceled
      // Since we map clientOrderId to blockchain_tx
      try {
        const order = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId: transactionHash });

        // Orders that are fully filled cannot be canceled
        if (order.status === 'filled') {
          // If Alpaca filled it but our indexer hasn't updated the DB yet, we update it now
          await pool.query("UPDATE transactions SET status = 'READY_TO_CLAIM' WHERE blockchain_tx = $1", [transactionHash]);
          throw new Error("Order is already completely filled on Alpaca. You must claim your assets.");
        }

        if (order.status === 'accepted' || order.status === 'new') {
          // Send the DELETE request to Alpaca
          await alpaca.trading.orders.deleteOrderByOrderID({ orderId: order.id });
          console.log(`❌ Canceled Alpaca order for tx: ${transactionHash}`);
        } else {
          throw new Error(`Order cannot be canceled right now. Current Alpaca status: ${order.status}`);
        }
      } catch (err) {
        // If Alpaca API throws an error, it might mean the order doesn't exist yet, or was already canceled.
        // We log it and assume we can safely cancel if we can't find it
        console.warn("Alpaca cancel warning:", err.message);
      }

      // 5. Update Database to CANCELED_BY_USER
      await pool.query(
        "UPDATE transactions SET status = 'CANCELED_BY_USER' WHERE blockchain_tx = $1",
        [transactionHash]
      );

      // Publish event via Redis
      const payload = JSON.stringify({
        walletAddress: tx.wallet_address,
        status: 'CANCELED_BY_USER',
        transactionHash: transactionHash
      });
      await redisClient.publish('transaction_updates', payload);

      // 6. Generate Signature so they can refund on-chain immediately
      // 6.1. Check cache first to prevent TOCTOU replay attacks
      const cachedSig = await redisClient.get(`RefundSig:${transactionHash}`);
      if (cachedSig) return JSON.parse(cachedSig);

      const lockKey = `Lock:${transactionHash}`;
      const acquired = await redisClient.setNX(lockKey, "1");
      if (!acquired) throw new Error("Transaction is currently being processed. Please try again.");
      await redisClient.expire(lockKey, 10);

      try {


        const timestamp = Math.floor(Date.now() / 1000);
        let messageHash;

        if (tx.type === 'MINT') {
          messageHash = keccak256(
            encodePacked(
              ['address', 'uint256', 'uint256', 'string'],
              [
                tx.wallet_address,
                parseUnits(tx.usdc_amount.toString(), 6),
                BigInt(timestamp),
                "cancelMint"
              ]
            )
          );
        } else if (tx.type === 'REDEEM') {
          messageHash = keccak256(
            encodePacked(
              ['address', 'uint256', 'uint256', 'string'],
              [
                tx.wallet_address,
                parseUnits(tx.dtsla_amount.toString(), 18),
                BigInt(timestamp),
                "cancelRedeem"
              ]
            )
          );
        }

        const signature = await oracleAccount.signMessage({ message: { raw: messageHash } });

        const result = {
          usdcAmount: tx.usdc_amount,
          dTslaAmount: tx.dtsla_amount,
          timestamp,
          signature
        };

        await redisClient.setEx(`RefundSig:${transactionHash}`, 280, JSON.stringify(result));
        return result;
      } finally {
        await redisClient.del(lockKey);
      }
    }
  }
};

module.exports = resolvers;
