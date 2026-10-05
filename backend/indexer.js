require('dotenv').config();
const { createPublicClient, http, webSocket, parseAbiItem, formatUnits, parseUnits } = require('viem');
const pool = require('./db');
const { alpaca } = require('./alpaca');
const { redisClient } = require('./redis');

// Setup Viem Client (HTTP for backlog, WS for real-time)
const client = createPublicClient({
  transport: http(process.env.ARBITRUM_RPC_URL || "http://127.0.0.1:8545")
});

const wsClient = createPublicClient({
  transport: webSocket(process.env.ARBITRUM_WS_URL)
});

const dTSLA_ADDRESS = process.env.DTSLA_ADDRESS;

// Contract Events
const depositReceivedEvent = parseAbiItem('event DepositReceived(address indexed user, uint256 usdcAmount, bytes signature)');
const mintedEvent = parseAbiItem('event Minted(address indexed user, uint256 usdcAmount, uint256 dTslaAmount)');
const redeemRequestedEvent = parseAbiItem('event RedeemRequested(address indexed user, uint256 dTslaAmount)');
const redeemedEvent = parseAbiItem('event Redeemed(address indexed user, uint256 dTslaAmount, uint256 usdcAmount)');
const mintCanceledEvent = parseAbiItem('event MintCanceled(address indexed user, uint256 usdcAmount)');
const redeemCanceledEvent = parseAbiItem('event RedeemCanceled(address indexed user, uint256 dTslaAmount)');
const whitelistUpdatedEvent = parseAbiItem('event WhitelistUpdated(address indexed account, bool status)');

async function initDB() {
  // Create table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      id INT PRIMARY KEY,
      last_processed_block BIGINT NOT NULL
    )
  `);

  // Ensure exactly one row exists (start at current block if fresh)
  const check = await pool.query('SELECT * FROM indexer_state WHERE id = 1');
  if (check.rows.length === 0) {
    const latest = await client.getBlockNumber();
    await pool.query('INSERT INTO indexer_state (id, last_processed_block) VALUES (1, $1)', [latest]);
    console.log(`Initialized indexer_state at block ${latest}`);
  }
}

async function handleDeposit(log) {
  const { transactionHash, args } = log;
  const { user, usdcAmount, signature } = args;

  const fiatAmount = formatUnits(usdcAmount, 6); // Lossless exact string from 6 decimals (USDC)

  console.log(`\n🎉 Caught DepositReceived Event in tx: ${transactionHash}`);
  console.log(`User ${user} locked $${fiatAmount} for dTSLA minting`);

  try {
    // 1. Ensure idempotency (skip if already processed)
    const checkTx = await pool.query('SELECT * FROM transactions WHERE blockchain_tx = $1', [transactionHash]);
    if (checkTx.rows.length > 0) {
      console.log(`Transaction ${transactionHash} already processed.`);
      return;
    }

    // 2. We need the user_id from the wallet address
    const userRes = await pool.query('SELECT id FROM users WHERE LOWER(wallet_address) = LOWER($1)', [user]);
    if (userRes.rows.length === 0) {
      console.error(`Unknown user wallet: ${user}`);
      return;
    }
    const user_id = userRes.rows[0].id;

    // 3. Insert transaction into DB as PENDING_ALPACA (dtsla_amount is 0 for now)
    await pool.query(
      `INSERT INTO transactions (user_id, wallet_address, type, usdc_amount, dtsla_amount, status, blockchain_tx)
       VALUES ($1, $2, 'MINT', $3, 0, 'PENDING_ALPACA', $4)`,
      [user_id, user, fiatAmount, transactionHash]
    );

    // 4. Mark Lock as COMPLETED in Redis to prevent timeout double-decrement
    await redisClient.set(`Lock:${signature}`, "COMPLETED");
    await redisClient.incrByFloat('alpaca:reserved_buying_power', -fiatAmount);

    // 5. Execute Trade on Alpaca
    const roundedNotional = parseFloat(Number(fiatAmount).toFixed(2));
    await alpaca.trading.orders.market({
      symbol: 'TSLA',
      side: 'buy',
      notional: roundedNotional, // Fractional share buying via fiat amount, must be 2 decimal places
      clientOrderId: transactionHash // Links Web3 tx hash to Web2 Alpaca Order!
    });
    console.log(`✅ Alpaca Market Buy Placed for $${fiatAmount} TSLA (Order ID: ${transactionHash})`);

    // 6. Broadcast the new pending transaction
    const payload = JSON.stringify({
      walletAddress: user,
      status: 'PENDING_ALPACA',
      transactionHash: transactionHash
    });
    await redisClient.publish('transaction_updates', payload);

  } catch (error) {
    console.error(`❌ Failed to process deposit for tx ${transactionHash}:`, error.message);

    // The Alpaca order completely failed to place. 
    // We MUST mark the transaction as FAILED so the user can be refunded on-chain!
    try {
      await pool.query(
        `UPDATE transactions SET status = 'FAILED' WHERE blockchain_tx = $1`,
        [transactionHash]
      );

      const payload = JSON.stringify({
        walletAddress: user,
        status: 'FAILED',
        transactionHash: transactionHash,
        reason: error.message || "Order rejected by Alpaca"
      });
      await redisClient.publish('transaction_updates', payload);
    } catch (dbError) {
      console.error(`❌ CRITICAL: Failed to mark tx ${transactionHash} as FAILED in DB:`, dbError.message);
    }
  }
}

async function handleMinted(log) {
  const { transactionHash, args } = log;
  const { user, usdcAmount } = args;

  const fiatAmount = formatUnits(usdcAmount, 6);

  console.log(`\n🎉 Caught Minted Event in tx: ${transactionHash}`);

  try {
    const userRes = await pool.query('SELECT id FROM users WHERE LOWER(wallet_address) = LOWER($1)', [user]);
    if (userRes.rows.length === 0) return;
    const user_id = userRes.rows[0].id;

    // Find the oldest READY_TO_CLAIM transaction for this user matching the amount
    const pendingTx = await pool.query(
      `SELECT * FROM transactions 
       WHERE user_id = $1 AND type = 'MINT' AND status = 'READY_TO_CLAIM' 
       AND ROUND(usdc_amount::numeric, 2) = ROUND($2::numeric, 2)
       ORDER BY created_at ASC LIMIT 1`,
      [user_id, fiatAmount]
    );

    if (pendingTx.rows.length > 0) {
      await pool.query(
        `UPDATE transactions SET status = 'COMPLETED', blockchain_tx = $1 WHERE id = $2`,
        [transactionHash, pendingTx.rows[0].id]
      );
      console.log(`✅ Marked Mint Transaction ${pendingTx.rows[0].id} as COMPLETED!`);

      const payload = JSON.stringify({
        walletAddress: user,
        status: 'COMPLETED',
        transactionHash: transactionHash
      });
      await redisClient.publish('transaction_updates', payload);
    } else {
      console.log(`⚠️  Could not find matching READY_TO_CLAIM tx for user ${user}`);
    }
  } catch (error) {
    console.error(`❌ Failed to process minted event for tx ${transactionHash}:`, error.message);
  }
}

async function handleRedeemRequested(log) {
  const { transactionHash, args } = log;
  const { user, dTslaAmount } = args;

  const shares = formatUnits(dTslaAmount, 18); // Lossless exact string from 18 decimals

  console.log(`\n🔥 Caught RedeemRequested Event in tx: ${transactionHash}`);
  console.log(`User ${user} locked ${shares} dTSLA to redeem`);

  try {
    // 1. Ensure idempotency
    const checkTx = await pool.query('SELECT * FROM transactions WHERE blockchain_tx = $1', [transactionHash]);
    if (checkTx.rows.length > 0) return;

    const userRes = await pool.query('SELECT id FROM users WHERE LOWER(wallet_address) = LOWER($1)', [user]);
    if (userRes.rows.length === 0) return;
    const user_id = userRes.rows[0].id;

    // 2. Insert transaction into DB as PENDING_ALPACA (type = REDEEM)
    await pool.query(
      `INSERT INTO transactions (user_id, wallet_address, type, usdc_amount, dtsla_amount, status, blockchain_tx)
       VALUES ($1, $2, 'REDEEM', 0, $3, 'PENDING_ALPACA', $4)`,
      [user_id, user, shares, transactionHash]
    );

    // 3. Execute Trade on Alpaca (Sell the shares)
    const roundedShares = parseFloat(Number(shares).toFixed(9));
    await alpaca.trading.orders.market({
      symbol: 'TSLA',
      side: 'sell',
      qty: roundedShares,
      clientOrderId: transactionHash
    });
    console.log(`✅ Alpaca Market Sell Placed for ${shares} TSLA (Order ID: ${transactionHash})`);

    // 4. Broadcast the new pending transaction
    const payload = JSON.stringify({
      walletAddress: user,
      status: 'PENDING_ALPACA',
      transactionHash: transactionHash
    });
    await redisClient.publish('transaction_updates', payload);

  } catch (error) {
    console.error(`❌ Failed to process redeem request for tx ${transactionHash}:`, error.message);

    // The Alpaca order completely failed to place (e.g. Wash Trade rule). 
    // We MUST mark the transaction as FAILED so the user can be refunded on-chain!
    try {
      await pool.query(
        `UPDATE transactions SET status = 'FAILED' WHERE blockchain_tx = $1`,
        [transactionHash]
      );

      const payload = JSON.stringify({
        walletAddress: user,
        status: 'FAILED',
        transactionHash: transactionHash,
        reason: error.message || "Order rejected by Alpaca"
      });
      await redisClient.publish('transaction_updates', payload);
    } catch (dbError) {
      console.error(`❌ CRITICAL: Failed to mark tx ${transactionHash} as FAILED in DB:`, dbError.message);
    }
  }
}

async function handleRedeem(log) {
  const { transactionHash, args } = log;
  const { user } = args;

  console.log(`\n🔥 Caught Redeemed Event in tx: ${transactionHash}`);

  try {
    const userRes = await pool.query('SELECT id FROM users WHERE LOWER(wallet_address) = LOWER($1)', [user]);
    if (userRes.rows.length === 0) return;
    const user_id = userRes.rows[0].id;

    // Find the oldest READY_TO_CLAIM_USDC transaction for this user
    const pendingTx = await pool.query(
      `SELECT * FROM transactions 
       WHERE user_id = $1 AND type = 'REDEEM' AND status = 'READY_TO_CLAIM_USDC' 
       ORDER BY created_at ASC LIMIT 1`,
      [user_id]
    );

    if (pendingTx.rows.length > 0) {
      await pool.query(
        `UPDATE transactions SET status = 'COMPLETED', blockchain_tx = $1 WHERE id = $2`,
        [transactionHash, pendingTx.rows[0].id]
      );
      console.log(`✅ Marked Redeem Transaction ${pendingTx.rows[0].id} as COMPLETED!`);

      const payload = JSON.stringify({
        walletAddress: user,
        status: 'COMPLETED',
        transactionHash: transactionHash
      });
      await redisClient.publish('transaction_updates', payload);
    }
  } catch (error) {
    console.error(`❌ Failed to process redeemed event for tx ${transactionHash}:`, error.message);
  }
}

async function handleMintCanceled(log) {
  const { transactionHash, args } = log;
  const { user } = args;

  console.log(`\n🎉 Caught MintCanceled Event in tx: ${transactionHash}`);
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE LOWER(wallet_address) = LOWER($1)', [user]);
    if (userRes.rows.length === 0) return;
    const user_id = userRes.rows[0].id;

    // We look for FAILED, CANCELED_BY_ADMIN, or CANCELED_BY_USER because it was marked when Alpaca rejected/canceled it.
    const pendingTx = await pool.query(
      `SELECT * FROM transactions WHERE user_id = $1 AND type = 'MINT' AND (status = 'FAILED' OR status = 'CANCELED_BY_ADMIN' OR status = 'CANCELED_BY_USER') ORDER BY created_at ASC LIMIT 1`,
      [user_id]
    );

    if (pendingTx.rows.length > 0) {
      await pool.query(
        `UPDATE transactions SET status = 'REFUNDED', blockchain_tx = $1 WHERE id = $2`,
        [transactionHash, pendingTx.rows[0].id]
      );
      console.log(`✅ Marked Mint Transaction ${pendingTx.rows[0].id} as REFUNDED!`);

      const payload = JSON.stringify({ walletAddress: user, status: 'REFUNDED', transactionHash: transactionHash });
      await redisClient.publish('transaction_updates', payload);
    }
  } catch (error) {
    console.error(`❌ Failed to process mint canceled event:`, error.message);
  }
}

async function handleRedeemCanceled(log) {
  const { transactionHash, args } = log;
  const { user } = args;

  console.log(`\n🔥 Caught RedeemCanceled Event in tx: ${transactionHash}`);
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE LOWER(wallet_address) = LOWER($1)', [user]);
    if (userRes.rows.length === 0) return;
    const user_id = userRes.rows[0].id;

    const pendingTx = await pool.query(
      `SELECT * FROM transactions WHERE user_id = $1 AND type = 'REDEEM' AND (status = 'FAILED' OR status = 'CANCELED_BY_ADMIN' OR status = 'CANCELED_BY_USER') ORDER BY created_at ASC LIMIT 1`,
      [user_id]
    );

    if (pendingTx.rows.length > 0) {
      await pool.query(
        `UPDATE transactions SET status = 'REFUNDED', blockchain_tx = $1 WHERE id = $2`,
        [transactionHash, pendingTx.rows[0].id]
      );
      console.log(`✅ Marked Redeem Transaction ${pendingTx.rows[0].id} as REFUNDED!`);

      const payload = JSON.stringify({ walletAddress: user, status: 'REFUNDED', transactionHash: transactionHash });
      await redisClient.publish('transaction_updates', payload);
    }
  } catch (error) {
    console.error(`❌ Failed to process redeem canceled event:`, error.message);
  }
}

async function handleWhitelistUpdated(log) {
  const { account, status } = log.args;
  console.log(`\n✅ Caught WhitelistUpdated Event: ${account} -> ${status}`);
  try {
    // Smart logic: Check if the address exists in the users table first!
    const userRes = await pool.query('SELECT id FROM users WHERE LOWER(wallet_address) = LOWER($1)', [account]);

    if (userRes.rows.length > 0) {
      // It's a user! Update the users table.
      await pool.query(
        `UPDATE users SET is_whitelisted = $1 WHERE LOWER(wallet_address) = LOWER($2)`,
        [status, account]
      );
      console.log(`Updated user ${account} to whitelisted: ${status}`);
    } else {
      // It's not in the users table, so it MUST be a smart contract/protocol!
      await pool.query(
        `INSERT INTO whitelisted_contracts (contract_address, name, is_whitelisted, updated_at) 
         VALUES ($2, 'Whitelisted Protocol', $1, CURRENT_TIMESTAMP)
         ON CONFLICT (contract_address) 
         DO UPDATE SET is_whitelisted = EXCLUDED.is_whitelisted, updated_at = CURRENT_TIMESTAMP`,
        [status, account.toLowerCase()]
      );
      console.log(`Updated protocol ${account} to whitelisted: ${status}`);
    }
  } catch (error) {
    console.error(`❌ Failed to process whitelist event:`, error.message);
  }
}



// -------------------------------------------------------------
// ALPACA WEBSOCKET (PHASE 2)
// -------------------------------------------------------------
function setupAlpacaWebSocket() {
  const updates = alpaca.trading.stream();

  updates.onConnect(() => {
    console.log(`🔌 Alpaca WebSocket Connected`);
    updates.subscribeTradeUpdates();
  });

  updates.onTradeUpdate(async (update) => {
    const { event, order } = update;
    const { client_order_id, filled_qty, filled_avg_price, symbol, side } = order;

    if (event === 'fill' || event === 'partial_fill') {
      console.log(`\n🔔 TRADE ${event.toUpperCase()}: ${side} ${filled_qty} ${symbol} @ $${filled_avg_price}`);
      console.log(`Client Order ID: ${client_order_id}`);

      try {
        const checkTx = await pool.query(`SELECT type FROM transactions WHERE blockchain_tx = $1`, [client_order_id]);
        if (checkTx.rows.length === 0) return;
        const txType = checkTx.rows[0].type;

        let updateRes;
        let newStatus = '';

        if (txType === 'MINT') {
          // If it's a partial_fill, we shouldn't mark it READY_TO_CLAIM yet because the order is still open!
          // But for simplicity in this MVP, we will only transition when the order is completely filled.
          if (event === 'partial_fill') {
            console.log(`⏳ Order ${client_order_id} partially filled. Waiting for full fill...`);
            return;
          }

          updateRes = await pool.query(
            `UPDATE transactions 
             SET dtsla_amount = $1, status = 'READY_TO_CLAIM' 
             WHERE blockchain_tx = $2 AND status = 'PENDING_ALPACA'
             RETURNING *`,
            [String(filled_qty), client_order_id]
          );
          newStatus = 'READY_TO_CLAIM';
        } else if (txType === 'REDEEM') {
          if (event === 'partial_fill') {
            console.log(`⏳ Order ${client_order_id} partially filled. Waiting for full fill...`);
            return;
          }

          // Safely truncate the price to 6 decimals to prevent parseUnits from crashing
          let safePriceStr = String(filled_avg_price);
          if (safePriceStr.includes('.')) {
            safePriceStr = safePriceStr.split('.')[0] + '.' + safePriceStr.split('.')[1].substring(0, 6);
          }
          const priceWei = parseUnits(safePriceStr, 6);

          // Safely truncate the qty to 18 decimals
          let safeQtyStr = String(filled_qty);
          if (safeQtyStr.includes('.')) {
            safeQtyStr = safeQtyStr.split('.')[0] + '.' + safeQtyStr.split('.')[1].substring(0, 18);
          }
          const qtyWei = parseUnits(safeQtyStr, 18);

          const usdcFilledWei = (priceWei * qtyWei) / 10n ** 18n;
          const usdcFilledStr = formatUnits(usdcFilledWei, 6);
          updateRes = await pool.query(
            `UPDATE transactions 
             SET usdc_amount = $1, status = 'READY_TO_CLAIM_USDC' 
             WHERE blockchain_tx = $2 AND status = 'PENDING_ALPACA'
             RETURNING *`,
            [usdcFilledStr, client_order_id]
          );
          newStatus = 'READY_TO_CLAIM_USDC';
        }

        if (updateRes && updateRes.rows.length > 0) {
          console.log(`✅ Transaction ${client_order_id} is now ${newStatus}!`);

          const userId = updateRes.rows[0].user_id;
          const userRes = await pool.query('SELECT wallet_address FROM users WHERE id = $1', [userId]);
          if (userRes.rows.length > 0) {
            const walletAddress = userRes.rows[0].wallet_address;

            const payload = JSON.stringify({
              walletAddress,
              status: newStatus,
              transactionHash: client_order_id
            });
            await redisClient.publish('transaction_updates', payload);
            console.log(`📡 Broadcasted ${newStatus} to frontend for ${walletAddress}`);
          }
        }
      } catch (error) {
        console.error("❌ Failed to update DB on Trade Fill:", error.message);
      }
    } else if (event === 'rejected' || event === 'canceled' || event === 'expired') {
      console.log(`\n🚨 TRADE FAILED: ${side} ${symbol} (Reason: ${event})`);
      console.log(`Client Order ID: ${client_order_id}`);

      const failStatus = event === 'canceled' ? 'CANCELED_BY_ADMIN' : 'FAILED';

      try {
        const updateRes = await pool.query(
          `UPDATE transactions SET status = $1 WHERE blockchain_tx = $2 AND status = 'PENDING_ALPACA' RETURNING *`,
          [failStatus, client_order_id]
        );

        if (updateRes && updateRes.rows.length > 0) {
          console.log(`❌ Transaction ${client_order_id} is now ${failStatus}!`);
          const userId = updateRes.rows[0].user_id;
          const userRes = await pool.query('SELECT wallet_address FROM users WHERE id = $1', [userId]);
          if (userRes.rows.length > 0) {
            const walletAddress = userRes.rows[0].wallet_address;
            const payload = JSON.stringify({
              walletAddress,
              status: failStatus,
              transactionHash: client_order_id,
              reason: `Order was ${event} by Alpaca`
            });
            await redisClient.publish('transaction_updates', payload);
          }
        }
      } catch (error) {
        console.error("❌ Failed to update DB on Trade Failure:", error.message);
      }
    }
  });

  updates.connect();
}

async function reconcilePendingOrders() {
  try {
    // ONLY check orders that have been stuck for more than 5 minutes!
    // The WebSocket handles orders instantly, so 99.9% of the time this returns 0 rows
    // Meaning ZERO API calls to Alpaca!
    const pendingRes = await pool.query(`
      SELECT * FROM transactions 
      WHERE status = 'PENDING_ALPACA' 
      AND created_at < NOW() - INTERVAL '5 minutes'
    `);

    if (pendingRes.rows.length === 0) return; // Perfect. Do nothing.

    console.log(`\n🔄 Reconciling ${pendingRes.rows.length} PENDING_ALPACA orders...`);

    for (const tx of pendingRes.rows) {
      try {
        const order = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId: tx.blockchain_tx });

        if (order.status === 'filled') {
          console.log(`✅ Order ${tx.blockchain_tx} was filled! Reconciling database...`);

          let updateRes;
          let newStatus = '';

          if (tx.type === 'MINT') {
            updateRes = await pool.query(
              `UPDATE transactions 
               SET dtsla_amount = $1, status = 'READY_TO_CLAIM' 
               WHERE blockchain_tx = $2 AND status = 'PENDING_ALPACA'
               RETURNING *`,
              [String(order.filled_qty), tx.blockchain_tx]
            );
            newStatus = 'READY_TO_CLAIM';
          } else if (tx.type === 'REDEEM') {
            let safePriceStr = String(order.filled_avg_price);
            if (safePriceStr.includes('.')) {
              safePriceStr = safePriceStr.split('.')[0] + '.' + safePriceStr.split('.')[1].substring(0, 6);
            }
            const priceWei = parseUnits(safePriceStr, 6);

            let safeQtyStr = String(order.filled_qty);
            if (safeQtyStr.includes('.')) {
              safeQtyStr = safeQtyStr.split('.')[0] + '.' + safeQtyStr.split('.')[1].substring(0, 18);
            }
            const qtyWei = parseUnits(safeQtyStr, 18);

            const usdcFilledWei = (priceWei * qtyWei) / 10n ** 18n;
            const usdcFilledStr = formatUnits(usdcFilledWei, 6);
            updateRes = await pool.query(
              `UPDATE transactions 
               SET usdc_amount = $1, status = 'READY_TO_CLAIM_USDC' 
               WHERE blockchain_tx = $2 AND status = 'PENDING_ALPACA'
               RETURNING *`,
              [usdcFilledStr, tx.blockchain_tx]
            );
            newStatus = 'READY_TO_CLAIM_USDC';
          }

          if (updateRes && updateRes.rows.length > 0) {
            const userId = updateRes.rows[0].user_id;
            const userRes = await pool.query('SELECT wallet_address FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length > 0) {
              const walletAddress = userRes.rows[0].wallet_address;
              const payload = JSON.stringify({
                walletAddress,
                status: newStatus,
                transactionHash: tx.blockchain_tx
              });
              await redisClient.publish('transaction_updates', payload);
              console.log(`📡 Broadcasted ${newStatus} (Reconciliation) to frontend for ${walletAddress}`);
            }
          }
        } else if (order.status === 'rejected' || order.status === 'canceled' || order.status === 'expired') {
          console.log(`🚨 Order ${tx.blockchain_tx} was ${order.status}! Reconciling database to FAILED...`);

          const failStatus = order.status === 'canceled' ? 'CANCELED_BY_ADMIN' : 'FAILED';

          const updateRes = await pool.query(
            `UPDATE transactions SET status = $1 WHERE blockchain_tx = $2 AND status = 'PENDING_ALPACA' RETURNING *`,
            [failStatus, tx.blockchain_tx]
          );
          if (updateRes && updateRes.rows.length > 0) {
            const userId = updateRes.rows[0].user_id;
            const userRes = await pool.query('SELECT wallet_address FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length > 0) {
              const walletAddress = userRes.rows[0].wallet_address;
              const payload = JSON.stringify({
                walletAddress,
                status: failStatus,
                transactionHash: tx.blockchain_tx
              });
              await redisClient.publish('transaction_updates', payload);
            }
          }
        } else {
          console.log(`⏳ Order ${tx.blockchain_tx} is still ${order.status}`);
        }
      } catch (err) {
        console.error(`❌ Failed to fetch order ${tx.blockchain_tx} from Alpaca:`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ Reconciliation failed:", err.message);
  }
}

let inMemoryLastProcessedBlock = null;
let lastDbUpdateBlock = null;

async function syncBacklog() {
  try {
    if (inMemoryLastProcessedBlock === null) {
      const stateRes = await pool.query('SELECT last_processed_block FROM indexer_state WHERE id = 1');
      inMemoryLastProcessedBlock = BigInt(stateRes.rows[0].last_processed_block);
      lastDbUpdateBlock = inMemoryLastProcessedBlock;
    }

    let fromBlock = inMemoryLastProcessedBlock + 1n;
    const currentBlock = await client.getBlockNumber();

    if (fromBlock <= currentBlock) {
      console.log(`🔄 Syncing backlog from block ${fromBlock} to ${currentBlock}...`);
    }

    while (fromBlock <= currentBlock) {
      let toBlock = currentBlock;

      if (toBlock - fromBlock > 9n) {
        toBlock = fromBlock + 9n;
      }

      console.log(`🔍 Syncing blocks ${fromBlock} to ${toBlock}...`);

      const logs = await client.getLogs({
        address: dTSLA_ADDRESS,
        events: [depositReceivedEvent, mintedEvent, redeemRequestedEvent, redeemedEvent, mintCanceledEvent, redeemCanceledEvent, whitelistUpdatedEvent],
        fromBlock,
        toBlock
      });

      for (const log of logs) {
        if (log.eventName === 'DepositReceived') {
          await handleDeposit(log);
        } else if (log.eventName === 'Minted') {
          await handleMinted(log);
        } else if (log.eventName === 'RedeemRequested') {
          await handleRedeemRequested(log);
        } else if (log.eventName === 'Redeemed') {
          await handleRedeem(log);
        } else if (log.eventName === 'MintCanceled') {
          await handleMintCanceled(log);
        } else if (log.eventName === 'RedeemCanceled') {
          await handleRedeemCanceled(log);
        } else if (log.eventName === 'WhitelistUpdated') {
          await handleWhitelistUpdated(log);
        }
      }

      if (logs.length > 0 || (toBlock - lastDbUpdateBlock >= 100n)) {
        await pool.query('UPDATE indexer_state SET last_processed_block = $1 WHERE id = 1', [toBlock.toString()]);
        lastDbUpdateBlock = toBlock;
      }

      inMemoryLastProcessedBlock = toBlock;
      fromBlock = toBlock + 1n;
    }
    console.log("✅ Backlog sync complete!");
  } catch (error) {
    console.error("❌ Sync error:", error.message);
  }
}

function watchEvents() {
  console.log("📡 Subscribing to real-time events via WebSocket...");
  wsClient.watchContractEvent({
    address: dTSLA_ADDRESS,
    abi: [depositReceivedEvent, mintedEvent, redeemRequestedEvent, redeemedEvent, mintCanceledEvent, redeemCanceledEvent, whitelistUpdatedEvent],
    onLogs: async (logs) => {
      if (logs.length === 0) return;

      for (const log of logs) {
        if (log.eventName === 'DepositReceived') {
          await handleDeposit(log);
        } else if (log.eventName === 'Minted') {
          await handleMinted(log);
        } else if (log.eventName === 'RedeemRequested') {
          await handleRedeemRequested(log);
        } else if (log.eventName === 'Redeemed') {
          await handleRedeem(log);
        } else if (log.eventName === 'MintCanceled') {
          await handleMintCanceled(log);
        } else if (log.eventName === 'RedeemCanceled') {
          await handleRedeemCanceled(log);
        }
      }

      // ⚡ BATCH OPTIMIZATION: Only update the database ONCE at the very end of the batch
      // rather than spamming the database for every individual event.
      const lastLog = logs[logs.length - 1];
      await pool.query('UPDATE indexer_state SET last_processed_block = $1 WHERE id = 1', [lastLog.blockNumber.toString()]);
    }
  });
}

async function start() {
  console.log("🚀 Starting Blockchain Indexer...");
  await redisClient.connect();
  await initDB();

  if (!dTSLA_ADDRESS) {
    console.warn("⚠️  WARNING: DTSLA_ADDRESS is not set in .env! Indexer will fail to fetch logs.");
  }

  setupAlpacaWebSocket();

  // Start the Lazy Reconciliation loop 
  // (Runs every 60 seconds, but 99.9% of the time it only hits the DB and makes 0 API calls to Alpaca)
  setInterval(reconcilePendingOrders, 60000);

  await syncBacklog(); // incase our backend server is down we have to re run back end again so this function will sync the block the backend failed to capture while its down

  watchEvents();
}

start();
