import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { db } from "./firebase.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
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