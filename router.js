app.post("/api/payment/webhook", async (req, res) => {
  try {
    const payload = req.body;

    console.log("🔥 Webhook received:", payload.event);

    // ONLY HANDLE SUCCESSFUL PAYMENTS
    if (payload.event !== "charge.completed") {
      return res.sendStatus(200);
    }

    const data = payload.data;

    if (data.status !== "successful") {
      return res.sendStatus(200);
    }

    const txRef = data.tx_ref;
    const transactionId = data.id;

    const platformShare = transaction.meta?.platformShare || 200;

    await db.collection("adminRevenue").add({
      amount: platformShare,
      tutorId,
      tutorialId,
      txRef,
      createdAt: new Date()
    });

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
    // GET METADATA (IMPORTANT)
    // ============================
    const {
      userId,
      tutorId,
      tutorialId,
      amount,
      tutorShare
    } = transaction.meta || {};

    if (!userId || !tutorialId) {
      return res.status(400).send("Missing metadata");
    }

    // ============================
    // PREVENT DOUBLE PROCESSING
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
    // MARK TRANSACTION AS DONE
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