import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import crypto from "crypto";
import aiRoutes from "./routes/ai.js";
import { db } from "./firebase.js";
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" };

dotenv.config();
// ============================
// 🔥 FIREBASE ADMIN INIT
// ============================
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const app = express();
app.use("/api/ai", aiRoutes);
// ============================
// 🛡 SECURITY MIDDLEWARE
// ============================
app.use(cors({
  origin: "https://unihelp-flax.vercel.app"
}));

app.use(express.json());

// ============================
// 🚦 RATE LIMITING
// ============================
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60
});

app.use(limiter);

// ============================
// 🔐 FIREBASE AUTH VERIFY
// ============================
const verifyUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) return res.sendStatus(401);

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.sendStatus(403);
  }
};

// ============================
// 🔐 ADMIN CHECK
// ============================
const verifyAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) return res.sendStatus(401);

  const decoded = await admin.auth().verifyIdToken(token);

  if (!decoded.admin) return res.sendStatus(403);

  req.user = decoded;
  next();
};

// ============================
// 💳 CREATE PAYMENT
// ============================
app.post("/api/pay", verifyUser, async (req, res) => {
  try {
    const { amount, email, tutorialId, tutorId } = req.body;

    const tutorShare = Math.round(amount * 0.7);
    const platformShare = Math.round(amount * 0.3);

   const payload = {
  tx_ref: "tx_" + Date.now(),
  amount,
  currency: "NGN",
  redirect_url: "https://unihelp-flax.vercel.app/tutorialmarketplace",
  customer: { email },
  meta: {
    userId: req.user.uid,
    tutorId,
    tutorialId,
    amount,
    tutorShare,
    platformShare
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
  } catch (err) {
    console.error("PAY ERROR FULL:", {
      message: err.message,
      data: err.response?.data,
      status: err.response?.status
    });
    res.status(500).json({ error: "Payment failed" });
  }
});

// ============================
// 🔔 WEBHOOK (IDEMPOTENT + SAFE)
// ============================
app.post("/api/payment/webhook", async (req, res) => {
  try {
    const secretHash = process.env.FLW_SECRET_HASH;
const signature = req.headers["verif-hash"];

    if (!signature || signature !== secretHash) {
      console.log("Invalid webhook signature");
      return res.sendStatus(401);
    }

    const payload = req.body;

    if (payload.event !== "charge.completed") return res.sendStatus(200);

    const data = payload.data;
    if (data.status !== "successful") return res.sendStatus(200);

    const txRef = data.tx_ref;
    const transactionId = data.id;

    // ============================
    // 🔒 IDEMPOTENCY CHECK
    // ============================
    const txRefDoc = db.collection("transactions").doc(txRef);
    const exists = await txRefDoc.get();

    if (exists.exists) return res.sendStatus(200);

    // verify with Flutterwave
    const verifyRes = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
        }
      }
    );

    const transaction = verifyRes.data.data;
    if (transaction.status !== "successful") return res.sendStatus(400);

    const meta = transaction.meta;
    if (!meta?.userId || !meta?.tutorialId) return res.sendStatus(400);

    // ============================
    // 💰 WRITE PURCHASE
    // ============================
    const batch = db.batch();

    const purchaseRef = db.collection("purchases").doc();
    const earningsRef = db.collection("tutorEarnings").doc();
    const revenueRef = db.collection("adminRevenue").doc();

    batch.set(purchaseRef, {
      userId: meta.userId,
      tutorId: meta.tutorId,
      tutorialId: meta.tutorialId,
      amount: meta.amount,
      txRef,
      createdAt: new Date()
    });

    batch.set(earningsRef, {
      tutorId: meta.tutorId,
      amount: meta.tutorShare,
      txRef,
      createdAt: new Date()
    });

    batch.set(revenueRef, {
      amount: meta.platformShare,
      txRef,
      createdAt: new Date()
    });

    batch.set(txRefDoc, {
      status: "processed",
      txRef,
      createdAt: new Date()
    });

    await batch.commit();

    return res.sendStatus(200);
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
    return res.sendStatus(500);
  }
});

// ============================
// 💸 WITHDRAWAL (WALLET BASED)
// ============================
app.post("/api/withdraw", verifyUser, async (req, res) => {
  try {
    const { amount } = req.body;
    const tutorId = req.user.uid;

    const earningsSnap = await db.collection("tutorEarnings")
      .where("tutorId", "==", tutorId)
      .get();

    let earned = 0;
    earningsSnap.forEach(d => earned += d.data().amount || 0);

    const withdrawSnap = await db.collection("withdrawals")
      .where("tutorId", "==", tutorId)
      .where("status", "in", ["pending", "paid"])
      .get();

    let withdrawn = 0;
    withdrawSnap.forEach(d => {
      withdrawn += d.data().amount || 0;
    });

    const available = Math.max(0, earned - withdrawn);

    if (amount > available) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    await db.collection("withdrawals").add({
      tutorId,
      amount,
      status: "pending",
      bankCode: req.body.bankCode,
      accountNumber: req.body.accountNumber,
      createdAt: new Date()
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================
// 🏦 ADMIN PAYOUT
// ============================
app.post("/api/admin/pay-withdrawal", verifyAdmin, async (req, res) => {
  try {
    const { withdrawalId } = req.body;

    const ref = db.collection("withdrawals").doc(withdrawalId);
    const snap = await ref.get();

    if (!snap.exists) return res.status(404).json({ error: "Not found" });

    const data = snap.data();
    if (data.status === "paid") return res.status(400).json({ error: "Already paid" });

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

    if (response.data.status !== "success") {
      return res.status(500).json({ error: "Transfer failed" });
    }

    await ref.update({
      status: "paid",
      paidAt: new Date()
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// 📊 ADMIN STATS (FAST)
// ============================
app.get("/api/admin/stats", verifyAdmin, async (req, res) => {
  try {
    const revenueSnap = await db.collection("adminRevenue").get();
    const withdrawSnap = await db.collection("withdrawals")
      .where("status", "==", "paid")
      .get();

    let revenue = 0;
    let withdrawn = 0;

    revenueSnap.forEach(d => revenue += d.data().amount || 0);
    withdrawSnap.forEach(d => withdrawn += d.data().amount || 0);

    res.json({
      revenue,
      withdrawn,
      profit: Math.max(0, revenue - withdrawn)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// 🚀 START SERVER
// ============================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("🚀 Production server running on", PORT);
});