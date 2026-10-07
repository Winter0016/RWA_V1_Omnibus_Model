const jwt = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkRpY0ZINDlxdXh4MFcyTE5kTl8tTU1YMElKQ2lOd20zRzQ4dTdLeFU5OEEifQ.eyJzaWQiOiJjbXV3Y3M5ZHIwMG8xMGNsYTExOGg3ZnRuIiwiaXNzIjoicHJpdnkuaW8iLCJpYXQiOjE3OTEyODE4MDIsImF1ZCI6ImNtdTZtYXF1bDAwMmkwY2pwc3FiYzF4eGEiLCJzdWIiOiJkaWQ6cHJpdnk6Y211cXE4ZGF3MDNtdTBlampubGpwMWlpaCIsImV4cCI6MTc5MTI4NTQwMn0.uxn1Sv0RXtmBNWXKS7yw7mkiNPSoI2w3-MGeh829dzI6KCvhsttt0X7Qfjja_n0e6LcOhhemB5mLlpY39Y4tAw"; // You need to grab your JWT from the browser network tab

const ENDPOINT = "http://localhost:4000/graphql";
const WALLET = "0xff20C6091527aA33ADa5dB48E9d7DC6C575C78FA"; // Put your actual wallet address here

//this function will check fund and then return signature if passed
const query = `
  mutation ReserveMintPower($usdcAmount: String!, $walletAddress: String!) {
    reserveMintPower(usdcAmount: $usdcAmount, wallet_address: $walletAddress) {
      timestamp
      signature
    }
  }
`;

const fireMutation = async (amountString, id) => {
  try {
    console.log(`[Req ${id}] Firing request to reserve $${amountString}...`);
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`
      },
      body: JSON.stringify({
        query,
        variables: {
          usdcAmount: amountString,
          walletAddress: WALLET
        }
      })
    });

    const result = await response.json();
    if (result.errors) {
      console.log(`❌ [Req ${id}] FAILED: ${result.errors[0].message}`);
    } else {
      console.log(`✅ [Req ${id}] SUCCESS: Reserved with signature ${result.data.reserveMintPower.signature.slice(0, 15)}...`);
    }
  } catch (err) {
    console.error(`❌ [Req ${id}] NETWORK ERROR:`, err.message);
  }
};

async function testRaceCondition() {
  console.log("🚀 Launching 3 simultaneous requests to test the Redis Check-and-Reserve lock...");

  // You have $99,813.20 in Alpaca buying power.
  // We fire 3 concurrent requests for $40,000 each.
  // Total attempted: $120,000.
  // 1st request ($40,000) -> Succeeds (Available: $59,813.20)
  // 2nd request ($40,000) -> Succeeds (Available: $19,813.20)
  // 3rd request ($40,000) -> FAILS! (Available: $19,813.20 < $40,000)

  const requests = [];
  for (let i = 1; i <= 3; i++) {
    // Note: The GraphQL schema expects usdcAmount as a String, so we pass "40000"
    requests.push(fireMutation("40000", i));
  }

  // Promise.all fires them concurrently at the exact same millisecond
  await Promise.all(requests);

  console.log("🏁 Race condition test complete.");
}

testRaceCondition();
