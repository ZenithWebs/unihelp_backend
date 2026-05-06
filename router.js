app.post("/api/pay", async (req, res) => {
  const { amount, email, tutorialId, userId, tutorId } = req.body;

  const payload = {
    tx_ref: "tx_" + Date.now(),
    amount,
    currency: "NGN",
    redirect_url: "https://yourfrontend.com/success",
    customer: { email },
    meta: {
      userId,
      tutorId,
      tutorialId,
      amount,
      tutorShare: amount * 0.7,
      platformShare: amount * 0.3
    }
  };

  const response = await axios.post(
    "https://api.flutterwave.com/v3/payments",
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
      }
    }
  );

  res.json(response.data);
});

app.post("/api/payment/webhook", async (req, res) => {
  try {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers["verif-hash"];

    if (!signature || signature !== secretHash) {
      return res.sendStatus(401);
    }

    const payload = req.body;

    if (payload.event !== "charge.completed") {
      return res.sendStatus(200);
    }

    const data = payload.data;

    if (data.status !== "successful") {
      return res.sendStatus(200);
    }

    const txRef = data.tx_ref;
    const transactionId = data.id;

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

    const meta = transaction.meta;

    if (!meta?.userId || !meta?.tutorialId) {
      return res.sendStatus(400);
    }

    const txDoc = db.collection("transactions").doc(txRef);
    const exists = await txDoc.get();

    if (exists.exists) return res.sendStatus(200);

    await db.collection("purchases").add({
      ...meta,
      txRef,
      createdAt: new Date()
    });

    await db.collection("tutorEarnings").add({
      tutorId: meta.tutorId,
      tutorialId: meta.tutorialId,
      amount: meta.tutorShare,
      txRef,
      createdAt: new Date()
    });

    await db.collection("adminRevenue").add({
      amount: meta.platformShare,
      tutorId: meta.tutorId,
      tutorialId: meta.tutorialId,
      txRef,
      createdAt: new Date()
    });

    await txDoc.set({
      txRef,
      status: "processed",
      createdAt: new Date()
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.sendStatus(500);
  }
});

app.post("/api/withdraw", async (req, res) => {
  try {
    const { tutorId, amount } = req.body;
    const amt = Number(amount);

    const earningsSnap = await db.collection("tutorEarnings")
      .where("tutorId", "==", tutorId)
      .get();

    let earned = 0;
    earningsSnap.forEach(d => earned += d.data().amount || 0);

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

    if (amt > available) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const pending = withdrawSnap.docs.find(d => d.data().status === "pending");

    if (pending) {
      return res.status(400).json({ error: "Pending withdrawal exists" });
    }

    await db.collection("withdrawals").add({
      tutorId,
      amount: amt,
      status: "pending",
      createdAt: new Date()
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});