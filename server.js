const express = require("express");
const admin = require("firebase-admin");

const app = express();

app.use(express.json());

/*
|--------------------------------------------------------------------------
| Firebase Admin SDK
|--------------------------------------------------------------------------
| Credentials बाद में Render Environment Variables से आएँगी।
| अभी GitHub में कोई Firebase secret/key नहीं डालना है।
|--------------------------------------------------------------------------
*/

let firebaseReady = false;

try {
  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });

    firebaseReady = true;
    console.log("Firebase Admin SDK initialized.");
  } else {
    console.log("Firebase credentials are not configured yet.");
  }
} catch (error) {
  console.error("Firebase initialization failed:", error.message);
}

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Dojo Platform Backend",
    status: "running",
    firebase: firebaseReady,
  });
});

/*
|--------------------------------------------------------------------------
| Customer Check
|--------------------------------------------------------------------------
*/

app.post("/customer/check", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "phoneNumber is required",
      });
    }

    if (!firebaseReady) {
      return res.status(503).json({
        success: false,
        message: "Firebase backend is not configured yet",
      });
    }

    const db = admin.firestore();

    /*
     * Firestore collection/schema को final करने के बाद
     * यहाँ exact customer lookup लगाया जाएगा.
     */

    return res.json({
      success: true,
      exists: false,
      message: "Customer check endpoint is ready",
    });
  } catch (error) {
    console.error("Customer check error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dojo Platform Backend running on port ${PORT}`);
});
