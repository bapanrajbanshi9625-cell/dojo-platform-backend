const express = require("express");
const admin = require("firebase-admin");

const app = express();

app.use(express.json());

let firebaseReady = false;

/*
|--------------------------------------------------------------------------
| Firebase Admin SDK
|--------------------------------------------------------------------------
*/

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
  console.error(
    "Firebase initialization failed:",
    error.message
  );
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
| Owner / Customer Check
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
        message: "Firebase backend is not configured",
      });
    }

    const db = admin.firestore();

    /*
     * Search inside owners collection.
     *
     * We check the phone fields because the existing
     * owner documents may contain the number in different
     * fields.
     */

    const phoneFields = [
      "mainPhone",
      "phone",
      "phoneNumber",
    ];

    let ownerDoc = null;

    for (const field of phoneFields) {
      const snapshot = await db
        .collection("owners")
        .where(field, "==", phoneNumber)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        ownerDoc = snapshot.docs[0];
        break;
      }
    }

    /*
     |--------------------------------------------------------------------------
     | Owner Found
     |--------------------------------------------------------------------------
     */

    if (ownerDoc) {
      const data = ownerDoc.data();

      return res.json({
        success: true,
        exists: true,
        profileCompleted:
            data.profileCompleted === true,
        ownerId: data.ownerId || null,
        authUid: data.authUid || null,
        role: data.role || "owner",
      });
    }

    /*
     |--------------------------------------------------------------------------
     | Owner Not Found
     |--------------------------------------------------------------------------
     */

    return res.json({
      success: true,
      exists: false,
      profileCompleted: false,
      ownerId: null,
      authUid: null,
      role: "owner",
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
  console.log(
    `Dojo Platform Backend running on port ${PORT}`
  );
});
