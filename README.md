# dTesla: Web3 Real World Assets (RWA)

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
