app.post("/api/payment/webhook", async (req, res) => {
  try {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers["verif-hash"];

    // 🔐 VERIFY WEBHOOK SOURCE
    if (!signature || signature !== secretHash) {
      console.log("❌ Invalid webhook signature");
      return res.sendStatus(401);
    }

    const payload = req.body;

    console.log("🔥 Webhook received:", payload.event);

    // Only process successful charges
    if (payload.event !== "charge.completed") {
      return res.sendStatus(200);
    }

    const data = payload.data;

    if (data.status !== "successful") {
      return res.sendStatus(200);
    }

    const txRef = data.tx_ref;
    const transactionId = data.id;

    // ============================
    // VERIFY WITH FLUTTERWAVE
    // ============================
    const verifyRes = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    const transaction = verifyRes.data.data;

    if (transaction.status !== "successful") {
      return res.sendStatus(400);
    }

    // ============================
    // GET METADATA
    // ============================
    const {
      userId,
      tutorId,
      tutorialId,
      amount,
      tutorShare,
      platformShare = 200
    } = transaction.meta || {};

    if (!userId || !tutorialId) {
      return res.status(400).send("Missing metadata");
    }

    // ============================
    // PREVENT DUPLICATES
    // ============================
    const txDoc = db.collection("transactions").doc(txRef);
    const exists = await txDoc.get();

    if (exists.exists) {
      return res.sendStatus(200);
    }

    // ============================
    // SAVE PURCHASE
    // ============================
    await db.collection("purchases").add({
      userId,
      tutorId,
      tutorialId,
      amount,
      txRef,
      createdAt: new Date()
    });

    // ============================
    // SAVE TUTOR EARNINGS
    // ============================
    await db.collection("tutorEarnings").add({
      tutorId,
      tutorialId,
      amount: tutorShare,
      txRef,
      createdAt: new Date()
    });
    // ============================
// 💸 WITHDRAWAL REQUEST
// ============================
app.post("/api/withdraw", async (req, res) => {
  const { tutorId, amount } = req.body;

  if (!tutorId || !amount) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const amt = Number(amount);

  // 🔐 GET EARNINGS
  const earningsSnap = await db.collection("tutorEarnings")
    .where("tutorId", "==", tutorId)
    .get();

  let earned = 0;
  earningsSnap.forEach(d => earned += d.data().amount || 0);

  // 🔐 GET WITHDRAWN
  const withdrawSnap = await db.collection("withdrawals")
    .where("tutorId", "==", tutorId)
    .get();

  let withdrawn = 0;
  withdrawSnap.forEach(d => {
    if (d.data().status === "paid") {
      withdrawn += d.data().amount || 0;
    }
  });

  const available = earned - withdrawn;

  // ❌ FRAUD CHECK 1
  if (amt > available) {
    return res.status(400).json({ error: "Insufficient balance" });
  }

  // ❌ FRAUD CHECK 2 (duplicate pending)
  const pending = withdrawSnap.docs.find(
    d => d.data().status === "pending"
  );

  if (pending) {
    return res.status(400).json({ error: "Pending withdrawal exists" });
  }

  // ✅ CREATE REQUEST
  await db.collection("withdrawals").add({
    tutorId,
    amount: amt,
    status: "pending",
    createdAt: new Date()
  });

  res.json({ success: true });
});
const recent = await db.collection("withdrawals")
  .where("tutorId", "==", tutorId)
  .orderBy("createdAt", "desc")
  .limit(3)
  .get();

const last = recent.docs[0]?.data();

if (last && (Date.now() - last.createdAt.toDate()) < 10 * 60 * 1000) {
  return res.status(429).json({ error: "Too many requests" });
}

// ============================
// 🏦 ADMIN PAY TUTOR
// ============================
app.post("/api/admin/pay-withdrawal", async (req, res) => {
  const { withdrawalId } = req.body;

  const docRef = db.collection("withdrawals").doc(withdrawalId);
  const snap = await docRef.get();

  if (!snap.exists) {
    return res.status(404).json({ error: "Not found" });
  }

  const data = snap.data();

  if (data.status === "paid") {
    return res.status(400).json({ error: "Already paid" });
  }

  // 💳 PAY VIA FLUTTERWAVE TRANSFER
  const response = await axios.post(
    "https://api.flutterwave.com/v3/transfers",
    {
      account_bank: data.bankCode,
      account_number: data.accountNumber,
      amount: data.amount,
      currency: "NGN",
      reference: "WD_" + Date.now(),
      narration: "Tutor payout"
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
      }
    }
  );

  if (!response.data.status === "success") {
    return res.status(500).json({ error: "Transfer failed" });
  }

  // ✅ MARK PAID
  await docRef.update({
    status: "paid",
    paidAt: new Date(),
    flutterwaveRef: response.data.data.reference
  });

  res.json({ success: true });
});
// ============================
// 📊 ADMIN STATS
// ============================
app.get("/api/admin/stats", async (req, res) => {
  try {
    const revenueSnap = await db.collection("adminRevenue").get();
    const withdrawalsSnap = await db.collection("withdrawals").get();

    let totalRevenue = 0;
    revenueSnap.forEach(doc => {
      totalRevenue += doc.data().amount || 0;
    });

    let totalWithdrawn = 0;
    withdrawalsSnap.forEach(doc => {
      if (doc.data().status === "paid") {
        totalWithdrawn += doc.data().amount || 0;
      }
    });

    res.json({
      totalRevenue,
      totalWithdrawn,
      profit: totalRevenue - totalWithdrawn
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

    // ============================
    // SAVE PLATFORM REVENUE
    // ============================
    await db.collection("adminRevenue").add({
      amount: platformShare,
      tutorId,
      tutorialId,
      txRef,
      createdAt: new Date()
    });

    // ============================
    // MARK TRANSACTION
    // ============================
    await txDoc.set({
      txRef,
      status: "processed",
      createdAt: new Date()
    });

    console.log("✅ Payment processed successfully");

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.sendStatus(500);
  }
});