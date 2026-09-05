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
| MSG91 Access Token Verification
|--------------------------------------------------------------------------
|
| Flutter sends the JWT access-token returned by MSG91
| after successful OTP verification.
|
| IMPORTANT:
| The MSG91 Authkey stays only on Render.
|
|--------------------------------------------------------------------------
*/

async function verifyMsg91AccessToken(accessToken) {
  const authKey = process.env.MSG91_AUTH_KEY;

  if (!authKey) {
    throw new Error("MSG91_AUTH_KEY is not configured");
  }

  if (!accessToken) {
    throw new Error("MSG91 access token is missing");
  }

  /*
   * MSG91 OTP Widget flow:
   *
   * Verify OTP
   *      ↓
   * JWT access-token
   *      ↓
   * Verify access-token
   *
   * The exact response is handled defensively because
   * MSG91 can return different response wrappers.
   */

  const response = await fetch(
    "https://api.msg91.com/api/v5/widget/verifyAccessToken",
    {
      method: "POST",
      headers: {
        authkey: authKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "access-token": accessToken,
      }),
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch (_) {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    console.error(
      "MSG91 access-token verification failed:",
      response.status
    );

    throw new Error("Invalid MSG91 access token");
  }

  return data;
}

/*
|--------------------------------------------------------------------------
| Extract Verified Phone From MSG91 Response
|--------------------------------------------------------------------------
*/

function extractVerifiedPhone(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const possibleValues = [
    data.mobile,
    data.phone,
    data.phoneNumber,
    data.mobileNumber,
    data.data?.mobile,
    data.data?.phone,
    data.data?.phoneNumber,
    data.data?.mobileNumber,
    data.user?.mobile,
    data.user?.phone,
    data.user?.phoneNumber,
  ];

  for (const value of possibleValues) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| Normalize Indian Phone Number
|--------------------------------------------------------------------------
*/

function normalizeIndianPhone(phoneNumber) {
  if (!phoneNumber) {
    return null;
  }

  let phone = String(phoneNumber).trim();

  phone = phone.replace(/\s+/g, "");

  if (phone.startsWith("+91")) {
    return phone;
  }

  if (phone.startsWith("91") && phone.length === 12) {
    return `+${phone}`;
  }

  if (/^\d{10}$/.test(phone)) {
    return `+91${phone}`;
  }

  return phone;
}

/*
|--------------------------------------------------------------------------
| Find Owner By Phone
|--------------------------------------------------------------------------
*/

async function findOwnerByPhone(phoneNumber) {
  const db = admin.firestore();

  const normalizedPhone = normalizeIndianPhone(phoneNumber);

  if (!normalizedPhone) {
    return null;
  }

  /*
   * Possible phone fields already used by the
   * existing Dojo owner documents.
   */

  const phoneValues = [
    normalizedPhone,
    normalizedPhone.replace("+91", ""),
    normalizedPhone.replace("+91", "91"),
  ];

  const phoneFields = [
    "mainPhone",
    "phone",
    "phoneNumber",
  ];

  for (const field of phoneFields) {
    for (const value of phoneValues) {
      const snapshot = await db
        .collection("owners")
        .where(field, "==", value)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        return snapshot.docs[0];
      }
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| Customer / Owner Check
|--------------------------------------------------------------------------
|
| Flutter should send:
|
| {
|   "accessToken": "MSG91_JWT"
| }
|
| NOT the phone number.
|
|--------------------------------------------------------------------------
*/

app.post("/customer/check", async (req, res) => {
  try {
    if (!firebaseReady) {
      return res.status(503).json({
        success: false,
        message: "Firebase backend is not configured",
      });
    }

    const accessToken = req.body?.accessToken;

    if (
      !accessToken ||
      typeof accessToken !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "accessToken is required",
      });
    }

    /*
     * Step 1:
     * Verify the token with MSG91.
     */

    const msg91Data =
      await verifyMsg91AccessToken(accessToken);

    /*
     * Step 2:
     * Extract the phone number that MSG91 itself verified.
     */

    const verifiedPhone =
      extractVerifiedPhone(msg91Data);

    if (!verifiedPhone) {
      console.error(
        "MSG91 response did not contain a verified phone number."
      );

      return res.status(401).json({
        success: false,
        message:
          "Unable to determine verified phone number",
      });
    }

    const normalizedPhone =
      normalizeIndianPhone(verifiedPhone);

    /*
     * Step 3:
     * Search the existing owners collection.
     */

    const ownerDoc =
      await findOwnerByPhone(normalizedPhone);

    /*
     |--------------------------------------------------------------------------
     | Existing Owner
     |--------------------------------------------------------------------------
     */

    if (ownerDoc) {
      const data = ownerDoc.data();

      return res.json({
        success: true,
        exists: true,

        profileCompleted:
          data.profileCompleted === true,

        ownerId:
          data.ownerId || ownerDoc.id,

        authUid:
          data.authUid ||
          data.uid ||
          null,

        role:
          data.role || "owner",

        phone:
          normalizedPhone,
      });
    }

    /*
     |--------------------------------------------------------------------------
     | New Owner
     |--------------------------------------------------------------------------
     */

    return res.json({
      success: true,
      exists: false,

      profileCompleted: false,

      ownerId: null,
      authUid: null,

      role: "owner",

      phone:
        normalizedPhone,
    });
  } catch (error) {
    console.error(
      "Customer check error:",
      error.message
    );

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

const PORT =
  process.env.PORT || 10000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Dojo Platform Backend running on port ${PORT}`
    );
  }
);
