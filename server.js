import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { db } from "./firebase.js";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});


app.use(cors({
  origin: "https://unihelp-flax.vercel.app/", 
}));

app.get("/", (req, res) => {
  res.send("API is running...");
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));