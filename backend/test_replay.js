const GRAPHQL_URL = 'http://localhost:4000/graphql';

// 1. Put your transaction hash here (Must be in READY_TO_CLAIM status!)
const TEST_TX_HASH = '0xaad7ede3ab486b7a6eea24d5a7631d23dc85be2c6c38342d66d5fc2404ef5d99';

// 2. Put your fresh JWT token here
const TEST_TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkRpY0ZINDlxdXh4MFcyTE5kTl8tTU1YMElKQ2lOd20zRzQ4dTdLeFU5OEEifQ.eyJzaWQiOiJjbXV3cndpbmUwMjlhMGNqcTVrdWw0bHdlIiwiaXNzIjoicHJpdnkuaW8iLCJpYXQiOjE3OTEzMDA1NzIsImF1ZCI6ImNtdTZtYXF1bDAwMmkwY2pwc3FiYzF4eGEiLCJzdWIiOiJkaWQ6cHJpdnk6Y211NnZlYjh6MDBvbTBjbDVtNDk3ZmJ3dCIsImV4cCI6MTc5MTMwNDE3Mn0.LNXR-ZJBZ5M9XYvVZdaoll8mWrGeZzQ_DEN003FHQE6MKBbqqmqAEoxJTUktw5s0Nn993My2pYah8Pz-ViUT3w';

async function testSpamAttack() {
  const query = `
    query GetClaimSignature($transactionHash: String!) {
      getClaimSignature(transactionHash: $transactionHash) {
        signature
      }
    }
  `;

  const variables = { transactionHash: TEST_TX_HASH };

  console.log(`🚀 Firing 10 concurrent requests for tx: ${TEST_TX_HASH}...`);

  const promises = [];
  for (let i = 1; i <= 10; i++) {
    promises.push(
      fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_TOKEN}`
        },
        body: JSON.stringify({ query, variables })
      }).then(res => res.json()).then(data => ({ id: i, data }))
    );
  }

  // Fire them all at the exact same millisecond
  const results = await Promise.all(promises);

  console.log("\n--- Results ---");

  let successCount = 0;
  let blockCount = 0;
  const uniqueSignatures = new Set();

  results.forEach(res => {
    if (res.data.errors) {
      console.log(`❌ [Req ${res.id}] BLOCKED by setNX: ${res.data.errors[0].message}`);
      blockCount++;
    } else if (res.data.data && res.data.data.getClaimSignature) {
      const sig = res.data.data.getClaimSignature.signature;
      console.log(`✅ [Req ${res.id}] SUCCESS: Signature returned -> ${sig.slice(0, 15)}...`);
      uniqueSignatures.add(sig);
      successCount++;
    }
  });

  console.log("\n--- Summary ---");
  console.log(`Total Successes: ${successCount}`);
  console.log(`Total Blocked (Caught by setNX): ${blockCount}`);
  console.log(`Unique Signatures Generated: ${uniqueSignatures.size}`);

  if (uniqueSignatures.size === 1 && blockCount > 0) {
    console.log("🛡️  SYSTEM SECURE! 1 thread generated the signature. The rest were either blocked by setNX or safely served from the Idempotency Cache.");
  } else if (uniqueSignatures.size > 1) {
    console.log("⚠️  VULNERABLE! Multiple UNIQUE signatures were generated simultaneously (TOCTOU failure).");
  } else {
    console.log("⚠️  Something else went wrong.");
  }
}

testSpamAttack();
