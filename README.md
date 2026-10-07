# dTesla: Web3 Real World Assets (RWA)

🎥 **Video Demonstration:** [Watch on YouTube](https://youtu.be/mZUmlqTZ_3Y)

**The video covers:**
- Zero-Friction User Onboarding (Privy Email Login)
- Gasless ERC-4337 USDC Transactions (Pimlico Paymaster)
- Live WebSocket Updates from the Backend
- The Two-Step Escrow Mint & Redeem Flow
- System-Level Revert and Refund Fallbacks (when the stock market is closed)
- Advanced System Architecture Testing (API Spam, Distributed Locks, and Race Conditions)

**dTesla** is a Real World Asset (RWA) project that tokenizes Tesla stock on-chain. It natively integrates with the **Alpaca Trading Platform** as a third-party brokerage to programmatically purchase and hold real-world Tesla shares, ensuring every `dTSLA` token minted on the blockchain is backed 1:1 by actual stock.

To provide a frictionless Web2-like experience, the project implements **Account Abstraction (ERC-4337)**. Users can simply log in using their Email or Google account via **Privy**, which automatically generates a secure embedded wallet for them. We then route their transactions through **Pimlico's Paymaster infrastructure**, allowing the smart account to interact on-chain and pay for gas fees directly in USDC, completely removing the need for users to hold native ETH.

## The Problem
The Real World Asset (RWA) movement aims to bridge traditional finance (TradFi) and Web3, but current solutions suffer from three major bottlenecks:
1. **Siloed Capital & Lack of Composability:** In traditional finance, if you own Tesla stock, its value is trapped inside a broker. You cannot easily use it as collateral for a loan or stake it in a liquidity pool.
2. **Global Payment Friction:** Purchasing US equities from outside the US traditionally requires slow international wire transfers and expensive foreign exchange (Forex) fees. 
3. **Web3 UX Onboarding:** Most decentralized platforms force users to manage private keys, bridge tokens, and pay volatile network gas fees in native ETH, which drives away retail users.

## The Solution
**dTesla** solves these bottlenecks by bringing US equities on-chain with zero UX friction:
- **Composability:** By tokenizing real TSLA shares into `dTSLA` on Arbitrum, users can now take their stock and plug it into the broader DeFi ecosystem (e.g., using it as collateral in lending protocols).
- **Global Access & 24/7 On-Chain Trading:** By turning real TSLA shares into `dTSLA` on Arbitrum, anyone globally can buy it with USDC. Once you mint `dTSLA`, you can send or trade it 24/7 on the blockchain, completely skipping the slow waiting times of traditional finance.
- **Easy Login:** Using Account Abstraction (Privy + Pimlico), users just log in with an email. A Smart Account pays their gas fees in USDC, so users never need to buy or touch ETH. The real TSLA stock is bought and sold automatically using the Alpaca API to keep a strict 1:1 backing.
- **Architectural Decision (Price Discovery vs 24/7 Minting):** To guarantee perfect 1:1 collateral backing, dTesla uses a **Direct-to-Broker** model. While an off-chain "Internal Crossing Engine" could allow 24/7 minting by matching user buys and sells internally, it introduces a critical **Price Discovery** flaw. Without a live institutional data feed (SIP), an internal engine cannot guarantee the exact execution price, leading to arbitrage risk. By routing directly to Alpaca, we rely on the live stock market for precise execution prices. This ensures mathematical safety, even if it means restricting primary Minting/Redeeming to active US Market Hours.

---

## System Architecture (Mint & Redeem Escrow Flows)

### 1. The Mint Flow (USDC -> dTSLA)

The protocol operates using a distributed backend architecture (splitting the GraphQL API and the Blockchain Indexer) to guarantee real-time UX without freezing the client.

```text
 +---------------+
 |  Frontend UI  |
 +---------------+
        │
        │ 1. reserveMint(USDC)
        ▼
 +-------------------+
 | Backend 1 (index) | (Checks Alpaca Funds)
 +-------------------+
        │
        │ 2. Returns Signature
        ▼
 +---------------+
 |  Frontend UI  |
 +---------------+
        │
        │ 3. depositForMint(USDC, Signature)
        ▼
 +----------------+
 | Smart Contract |
 +----------------+
        │
        │ 4. Emits DepositReceived Event
        ▼
 +-------------------+       5. Save Tx to DB         +--------------+
 |Backend 2 (indexer)| ────────────────────────────▶ |  PostgreSQL  |
 +-------------------+                               +--------------+
        │
        │ 6. Publishes state update (Pub/Sub)
        ▼
 +----------------+
 |     Redis      |
 +----------------+
        │
        │ 7. Forwards state
        ▼
 +-------------------+       8. WebSocket Update      +---------------+
 | Backend 1 (index) | ────────────────────────────▶ |  Frontend UI  |
 +-------------------+          (Pending Alpaca)     +---------------+

====================================================================
 
 +-------------------+       9. Execute Buy Order     +--------------+
 |Backend 2 (indexer)| ────────────────────────────▶ |  Alpaca API  |
 +-------------------+                               +--------------+
        ▲                                                   │
        │ 10. Order Filled (Webhook/WebSocket)              │
        └───────────────────────────────────────────────────┘

 +-------------------+       11. Mark READY_TO_CLAIM  +--------------+
 |Backend 2 (indexer)| ────────────────────────────▶ |  PostgreSQL  |
 +-------------------+                               +--------------+
        │
        │ 12. Publishes fill event (Pub/Sub)
        ▼
 +----------------+
 |     Redis      |
 +----------------+
        │
        │ 13. Forwards state
        ▼
 +-------------------+       14. WebSocket Update     +---------------+
 | Backend 1 (index) | ────────────────────────────▶ |  Frontend UI  |
 +-------------------+           (Trade Executed)    +---------------+

====================================================================

 +---------------+          13. Request EIP-712 Sig  +-------------------+
 |  Frontend UI  | ───────────────────────────────▶  | Backend 1 (index) |
 +---------------+                                   +-------------------+
        ▲                                                   │
        │ 14. Return EIP-712 Signature                      │
        └───────────────────────────────────────────────────┘
        
 +---------------+          15. claimMint(Signature) +----------------+
 |  Frontend UI  | ───────────────────────────────▶  | Smart Contract |
 +---------------+                                   +----------------+
        ▲                                                   │
        │ 16. Mints dTSLA to User's Smart Account           │
        └───────────────────────────────────────────────────┘
```

### 2. The Redeem Flow (dTSLA -> USDC)

```text
 +---------------+
 |  Frontend UI  |
 +---------------+
        │
        │ 1. requestRedeem(dTSLA)
        ▼
 +----------------+
 | Smart Contract |
 +----------------+
        │
        │ 2. Emits RedeemRequested Event
        ▼
 +-------------------+       3. Save Tx to DB         +--------------+
 |Backend 2 (indexer)| ────────────────────────────▶ |  PostgreSQL  |
 +-------------------+                               +--------------+
        │
        │ 4. Publishes state update (Pub/Sub)
        ▼
 +----------------+
 |     Redis      |
 +----------------+
        │
        │ 5. Forwards state
        ▼
 +-------------------+       6. WebSocket Update      +---------------+
 | Backend 1 (index) | ────────────────────────────▶ |  Frontend UI  |
 +-------------------+          (Pending Alpaca)     +---------------+

====================================================================
 
 +-------------------+       7. Execute Sell Order    +--------------+
 |Backend 2 (indexer)| ────────────────────────────▶ |  Alpaca API  |
 +-------------------+                               +--------------+
        ▲                                                   │
        │ 8. Order Filled (Webhook/WebSocket)               │
        └───────────────────────────────────────────────────┘

 +-------------------+       9. Mark READY_TO_CLAIM   +--------------+
 |Backend 2 (indexer)| ────────────────────────────▶ |  PostgreSQL  |
 +-------------------+                               +--------------+
        │
        │ 10. Publishes fill event (Pub/Sub)
        ▼
 +----------------+
 |     Redis      |
 +----------------+
        │
        │ 11. Forwards state
        ▼
 +-------------------+       12. WebSocket Update     +---------------+
 | Backend 1 (index) | ────────────────────────────▶ |  Frontend UI  |
 +-------------------+           (Trade Executed)    +---------------+

====================================================================

 +---------------+          13. Request EIP-712 Sig  +----------------+
 |  Frontend UI  | ───────────────────────────────▶  | Backend 1 index |
 +---------------+                                   +----------------+
        ▲                                                   │
        │ 14. Return EIP-712 Signature                      │
        └───────────────────────────────────────────────────┘
        
 +---------------+          15. claimUSDC(Signature) +----------------+
 |  Frontend UI  | ───────────────────────────────▶  | Smart Contract |
 +---------------+                                   +----------------+
        ▲                                                   │
        │ 16. Transfers USDC to User's Smart Account        │
        └───────────────────────────────────────────────────┘
```

### 3. The Wash Trade Edge Case (Omnibus Model)

Because dTesla uses a single Master 'Omnibus' account for all users, opposing orders placed while the market is closed are caught in the broker's pending queue, triggering a regulatory "Wash Trade" rejection. Our protocol automatically catches this and refunds the user.

```text
 User A (Mints dTSLA)          User B (Redeems dTSLA)
         │                                │
         │ (Market Closed)                │ (Market Closed)
         ▼                                ▼
 +------------------------------------------------+
 |             ALPACA PENDING QUEUE               |
 |                                                |
 |   [ Buy 1 TSLA ]          [ Sell 1 TSLA ]      |
 +------------------------------------------------+
                           │
                           ▼
          [ ❌ REJECTED: FINRA WASH TRADE ]
          Broker compliance flags the Master Account 
          for trying to buy and sell simultaneously.
                           │
                           ▼
 +------------------------------------------------+
 |              dTESLA BACKEND (INDEXER)          |
 |  1. Catches HTTP 403 Forbidden Error           |
 |  2. Broadcasts "FAILED" via Redis Pub/Sub      |
 +------------------------------------------------+
                           │
                           ▼
                 [ 💰 AUTOMATED REFUND ]
          Frontend prompts User A to sign for a 
          gasless USDC refund on-chain.
```

### 4. Theoretical V2 Architecture (Internal Crossing Engine)

To unlock 24/7 Minting and eliminate Wash Trade rules, a V2 architecture would introduce an off-chain Internal Crossing Engine. However, this is currently **BLOCKED** by the Price Discovery problem.

```text
 User A (Sells 3 TSLA)          User B (Buys 5 TSLA)
         │                                │
         ▼                                ▼
 +------------------------------------------------+
 |              REDIS CROSSING ENGINE             |
 |                                                |
 |  1. Matches 3 TSLA internally                  |
 |  2. Swaps User A's dTSLA for User B's USDC     |
 +------------------------------------------------+
         │                                │
         │ 3. Net Delta (Buy 2 TSLA)      │ 4. Internal Pricing
         ▼                                ▼
 +---------------+               +-----------------+
 |  Alpaca API   |               |   Price Feed    |
 +---------------+               +-----------------+
                                          │
                          [ ❌ BLOCKED BY PRICE DISCOVERY ]
                          Without a live institutional data feed (SIP),
                          the internal engine cannot guarantee the 
                          exact execution price of the matched 3 TSLA,
                          creating an unacceptable arbitrage risk.
```

---

## The Tech Stack

### 1. Account Abstraction (Privy + Pimlico)
- **Target Audience:** Web2 users who want exposure to stocks on-chain but don't want to manage private keys or ETH gas.
- **Privy:** Users log in with their email. A Smart Account (ERC-4337) is automatically generated for them in the background. No MetaMask required.
- **Paymaster (ERC-20 Gas):** When a user buys dTesla, they pay the network gas fee using their testnet USDC. The Pimlico Paymaster handles the conversion to ETH under the hood. The user never needs native tokens.

### 2. Backend (Node.js + PostgreSQL + Redis + GraphQL)
- **Node.js (Express & Viem):** Acts as the fast Web2 layer. It listens to blockchain events to index data in real-time.
- **Alpaca API:** The backend instantly executes live market buys and sells for real TSLA stock to collateralize the tokens.
- **PostgreSQL:** Acts as a relational indexer, caching user balances, pending transaction states (Pending, Completed, Refunded, Canceled), and whitelist statuses.
- **Redis:** Manages atomic check-and-reserve locks to prevent race conditions when executing live brokerage trades.
- **GraphQL (Apollo):** Serves the indexed user data and token supply metrics incredibly fast to the Next.js frontend. Secured by Privy JWT authentication.

### 3. Frontend (Next.js + Tailwind CSS)
- **Admin Dashboard:** A private page for the platform administrator to view the total `dTSLA` supply, all user balances, and manage protocol/user whitelists.
- **User Portfolio & Market:** A seamless storefront where users can view live TSLA prices, seamlessly execute 2-step gasless transactions, and request refunds if trades fail.
- **State Machines:** Highly resilient UI state flows to handle complex multi-step blockchain transactions with explicit UI feedback.

### 4. Smart Contracts (Foundry / Arbitrum Sepolia)
- **dTSLA.sol:** A UUPS Upgradeable ERC20 token contract utilizing a custom Two-Step Escrow architecture to completely eliminate counterparty execution risk:
  1. **Deposit:** User deposits USDC into the Vault on-chain.
  2. **Execute:** The Node.js backend hears the event, executes the stock trade on Alpaca, and signs an EIP-712 payload proving collateralization.
  3. **Claim:** User submits the Oracle signature to the blockchain to mint their dTSLA.
  4. **Refund:** If the brokerage trade fails, users can effortlessly claim a full USDC refund using an Oracle signature.

---

## Database Schema (PostgreSQL)

To maintain a highly resilient Escrow architecture and Zero-Trust GraphQL API, the backend utilizes four core tables in PostgreSQL:

### 1. `users`
**Purpose:** Enforces a Zero-Trust architecture by mapping authenticated Privy JWTs directly to the user's Smart Account wallet address.
- **Key Columns:** `id`, `privy_id` (JWT mapping), `wallet_address` (Smart Account), `role` (Admin/User).
- **Why it matters:** The GraphQL API never trusts a wallet address passed from the frontend client. It extracts the `privy_id` from the secure JWT, queries this table for the associated `wallet_address`, and generates EIP-712 signatures exclusively for that address to prevent spoofing.

### 2. `transactions`
**Purpose:** Acts as the central State Machine for the Two-Step Escrow process.
- **Key Columns:** `id`, `user_id`, `blockchain_tx` (Deposit Hash), `type` (MINT/REDEEM), `status`, `signature`.
- **Why it matters:** Tracks the exact lifecycle of an order (`PENDING_ALPACA` ➔ `READY_TO_CLAIM` ➔ `COMPLETED` or `FAILED`). It ensures idempotency (so the indexer doesn't process the same deposit twice) and stores the cryptographic signatures so the user can claim their tokens.

### 3. `whitelisted_contracts`
**Purpose:** Manages protocol-level access to the dTSLA token.
- **Key Columns:** `address`, `added_at`.
- **Why it matters:** While standard users authenticate via Privy, other Web3 protocols (like a DEX Liquidity Pool or Lending Protocol) don't have email addresses. The admin uses this table to whitelist specific smart contracts to hold and transfer `dTSLA`.

### 4. `indexer_state`
**Purpose:** Guarantees absolute blockchain event consistency.
- **Key Columns:** `id`, `last_processed_block`.
- **Why it matters:** If the Node.js backend crashes or restarts, the `indexer.js` worker checks this table upon boot. It will instantly resume scanning from the `last_processed_block`, ensuring absolutely zero Deposit or Redeem events are missed during downtime.

## Technical Edge Cases Solved (Proof of Implementation)

To build a production-ready Web3 integration, we had to solve several complex distributed systems and cybersecurity edge cases. Here is exactly how we implemented them:

### 1. Authentication & Authorization (Zero-Trust JWT)
**The Problem:** A malicious user could send a GraphQL mutation to cancel another user's transaction by forging the `user_id` payload.
**The Solution:** The backend enforces a Zero-Trust architecture. It verifies the Privy JWT server-side on every request and extracts the unforgeable `privyUserId`. If it doesn't match the transaction owner, it reverts.
**Evidence (`backend/resolvers.js`):**
```javascript
const userRes = await pool.query('SELECT privy_id FROM users WHERE id = $1', [tx.user_id]);
if (userRes.rows.length === 0 || userRes.rows[0].privy_id !== context.user.privyUserId) {
  throw new Error('Unauthorized: You do not own this transaction');
}
```

### 2. Disconnected Session Recovery (Orphaned Transactions)
**The Problem:** If a user closes their browser window while a stock trade is processing on Alpaca, the frontend loses the WebSocket callback. In basic architectures, this leaves the user's funds permanently stuck in limbo because they can never retrieve the Oracle signature.
**The Solution:** The frontend lifecycle is completely decoupled from backend execution. By exposing independent, idempotent endpoints (`getClaimSignature`, `getRedeemSignature`, and `getRefundSignature`), the backend can safely complete the trade and update PostgreSQL. The user can simply log back in days later and manually claim their tokens or refunds.
**Evidence (`backend/resolvers.js`):**
```javascript
getClaimSignature: async (_, { transactionHash }, context) => {
  // 1. Fetch the transaction independently of the active session
  const txRes = await pool.query('SELECT * FROM transactions WHERE blockchain_tx = $1', [transactionHash]);
  const tx = txRes.rows[0];

  // 2. Ensure it's ready to claim
  if (tx.status !== 'READY_TO_CLAIM') {
    throw new Error(`Transaction is not ready to claim. Current status: ${tx.status}`);
  }
```

### 3. API Spam & Double-Processing (TOCTOU & Atomic Locking)
**The Problem:** Because users can manually call `getClaimSignature`, `getRedeemSignature`, or `getRefundSignature` from disconnected sessions, a user could rapidly spam these claim buttons. This introduces a **TOCTOU (Time-Of-Check to Time-Of-Use)** vulnerability: if 10 requests hit the API at the exact same millisecond, all 10 would check the cache simultaneously, see that no signature exists, and proceed to generate duplicate Oracle signatures with conflicting timestamps.
**The Solution:** We implemented a two-step idempotency lock. First, we check Redis for a cached signature to prevent generating new signatures for old transactions. Second, we apply an atomic distributed lock using Redis `setNX` (Set if Not Exists) to mathematically guarantee that even if 10 threads bypass the cache check at the exact same millisecond, only one thread can actually execute the generation logic.
**Evidence (`backend/resolvers.js`):**
```javascript
// 1. Check cache first (Handles idempotency over time)
const cachedSig = await redisClient.get(`ClaimSig:${transactionHash}`);
if (cachedSig) return JSON.parse(cachedSig);

// 2. Atomic lock prevents TOCTOU concurrency (Handles simultaneous spam)
const lockKey = `Lock:${transactionHash}`;
const acquired = await redisClient.setNX(lockKey, "1");
if (!acquired) throw new Error("Transaction is already being processed.");
await redisClient.expire(lockKey, 10);
```

### 4. Race Condition: Broker Buying Power Overdraft (Atomic Check-and-Reserve)
**The Problem:** If 100 users simultaneously click "Mint", the backend could query Alpaca's available buying power, see $1,000 available, and approve all 100 transactions, causing massive overdrafts and failed broker executions.
**The Solution:** We built an atomic **Check-and-Reserve** pattern using Redis `incrByFloat`. It atomically reserves the fiat in a global pool and rolls back if it exceeds real buying power. We also built a distributed Saga with a 5-minute TTL that automatically releases the reserved fiat if the blockchain transaction drops. The background worker consumes this reservation upon success.
**Evidence (Cross-Service Synchronization):**
```javascript
// 1. API Boundary (backend/resolvers.js) - Atomic Check-and-Reserve
// 1. Get real cash balance from Alpaca
const availableFiat = await getAvailableFiat();

// 2. Atomically reserve the fiat first (Solves the Race Condition!)
const parsedUsdc = parseFloat(usdcAmount); //usdcAmount is the number of usdc input from user => the usdc amount user want to use to buy tsla token

const newReservedFiat = await redisClient.incrByFloat('alpaca:reserved_buying_power', parsedUsdc);

const previousReservedFiat = newReservedFiat - parsedUsdc;
const trulyAvailable = availableFiat - previousReservedFiat;

if (trulyAvailable < parsedUsdc) {
  await redisClient.incrByFloat('alpaca:reserved_buying_power', -parsedUsdc); // Rollback
  throw new Error(`Insufficient Buying Power. Available: $${trulyAvailable.toFixed(2)}`);
}

// Different code but mathematically identical result:
/*
const remainingFiat = availableFiat - newReservedFiat;
if (remainingFiat < 0) {
  await redisClient.incrByFloat('alpaca:reserved_buying_power', -parsedUsdc); // Rollback
  throw new Error(`Insufficient Buying Power`);
}
*/

// 2. Saga Deadlock Prevention (backend/resolvers.js)
await redisClient.setEx(`Lock:${signature}`, 300, usdcAmount.toString());
setTimeout(async () => {
  const status = await redisClient.get(`Lock:${signature}`);
  if (status !== "COMPLETED") { 
    await redisClient.incrByFloat('alpaca:reserved_buying_power', -usdcAmount); // Auto-release
  }
}, 5 * 60 * 1000);

// 3. Worker Boundary (backend/indexer.js) - Saga Completion
await redisClient.set(`Lock:${signature}`, "COMPLETED");
await redisClient.incrByFloat('alpaca:reserved_buying_power', -fiatAmount); // Consume reservation
```

### 5. Broker API Outage & Websocket Desync
**The Problem:** If the Alpaca WebSocket drops an event, a user's transaction could get permanently stuck in a `PENDING_ALPACA` state on our database.
**The Solution:** We built a self-healing **Reconciliation Engine**. A cron job runs every 60 seconds to fetch stuck orders directly from the Alpaca REST API and force the database to synchronize with the true broker state.
**Evidence (`backend/indexer.js`):**
```javascript
async function reconcilePendingOrders() {
  const pending = await pool.query("SELECT * FROM transactions WHERE status = 'PENDING_ALPACA'");
  for (const tx of pending.rows) {
    const order = await alpaca.trading.orders.getOrderByClientOrderId({ clientOrderId: tx.blockchain_tx });
    if (order.status === 'filled') {
      // Recover state and push WebSocket success directly to the frontend
    }
  }
}
setInterval(reconcilePendingOrders, 60000);
```

### 6. On-Chain Signature Replay Protection
**The Problem:** A user could theoretically capture their backend `claimMint` EIP-712 signature and submit it to the blockchain twice to double-mint `dTSLA` for free.
**The Solution:** The smart contract uses a strict `mapping(bytes32 => bool) public s_usedSignatures` and timestamp tracking to guarantee the mathematical single-use of every signature.
**Evidence (`contracts/dTSLA.sol`):**
```solidity
bytes32 messageHash = keccak256(
    abi.encodePacked(
        msg.sender,
        usdcAmount,
        timestamp,
        "depositForMint"
    )
);

if (s_usedSignatures[messageHash]) {
    revert dTSLA__InvalidSignature();
}
s_usedSignatures[messageHash] = true;
```

### 7. Indexer Idempotency (Chain Reorg Protection)
**The Problem:** The indexer could read the same `DepositReceived` event twice if the blockchain reorgs or the server restarts, resulting in 2 Alpaca orders for 1 payment.
**The Solution:** The indexer enforces mathematical idempotency by checking the database for the exact `transactionHash` before executing any broker trades.
**Evidence (`backend/indexer.js`):**
```javascript
const checkTx = await pool.query('SELECT * FROM transactions WHERE blockchain_tx = $1', [transactionHash]);
if (checkTx.rows.length > 0) {
  console.log(`⚠️ Transaction ${transactionHash} already processed. Skipping.`);
  return;
}
```

### 8. Floating-Point Precision & Rounding Errors
**The Problem:** JavaScript cannot safely handle 18-decimal blockchain numbers, leading to massive rounding errors (e.g., losing $0.15 of a user's funds during USDC ➔ dTSLA conversion).
**The Solution:** We completely bypassed JavaScript floating-point math by treating all broker prices as `BigInt` strings and manually padding the 18 decimals before generating the Oracle signature.
**Evidence (`backend/indexer.js`):**
```javascript
// Safely convert broker string to 18-decimal EVM BigInt without precision loss
const safeQtyStr = String(order.filled_qty);
const decimalsToAdd = 18 - safeQtyStr.split('.')[1].length;
const blockchainSafeQty = safeQtyStr.replace('.', '') + '0'.repeat(decimalsToAdd);
```

### 9. SQL Injection (SQLi) Prevention
**The Problem:** A malicious user could send a GraphQL request injecting SQL into the `transactionHash` parameter to dump or drop the database.
**The Solution:** Every single database interaction strictly uses Parameterized Queries (`$1`, `$2`), completely neutralizing all payload injection attempts.
**Evidence (`backend/resolvers.js`):**
```javascript
const pendingTx = await pool.query(
  `SELECT * FROM transactions WHERE user_id = $1 AND blockchain_tx = $2`, 
  [user.id, args.transactionHash] // Parameterized array blocks SQLi
);
```

---

## Live Demonstration

Because this project requires a complex environment of API keys (Alpaca, Privy, Pimlico), a local PostgreSQL database, Redis Pub/Sub, and an Arbitrum Sepolia RPC, running it locally is not feasible without extensive environment setup.

Instead, please watch the comprehensive **End-to-End Video Demonstration** showing the architecture in action:

📺 **[Watch the dTesla Architecture Demo Here] (Insert YouTube/Loom Link Here)**

**The video covers:**
1. Zero-Friction User Onboarding (Privy Email Login)
2. Gasless ERC-4337 USDC Transactions (Pimlico Paymaster)
3. Live WebSocket Updates from the Backend
4. The Two-Step Escrow Mint & Redeem Flow
5. System-Level Revert and Refund Fallbacks (when the stock market is closed)
