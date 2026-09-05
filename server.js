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

  const response = await fetch(
    "https://api.msg91.com/api/v5/widget/verifyAccessToken",
    {
      method: "POST",
      headers: {
        authkey: authKey,
        "Content-Type": "application/json",
        Accept: "application/json",
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

  console.log(
    "MSG91 ACCESS TOKEN STATUS:",
    response.status
  );

  if (data && typeof data === "object") {
    console.log(
      "MSG91 RESPONSE KEYS:",
      Object.keys(data)
    );

    if (data.data && typeof data.data === "object") {
      console.log(
        "MSG91 DATA KEYS:",
        Object.keys(data.data)
      );
    }
  }

  if (!response.ok) {
    throw new Error(
      `MSG91 access-token verification failed with status ${response.status}`
    );
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

    data.data?.user?.mobile,
    data.data?.user?.phone,
    data.data?.user?.phoneNumber,
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
  if (!firebaseReady) {
    throw new Error("Firebase Admin SDK is not ready");
  }

  const db = admin.firestore();

  const normalizedPhone =
    normalizeIndianPhone(phoneNumber);

  if (!normalizedPhone) {
    return null;
  }

  const cleanTenDigit =
    normalizedPhone.replace("+91", "");

  const phoneValues = [
    normalizedPhone,
    cleanTenDigit,
    `91${cleanTenDigit}`,
  ];

  const phoneFields = [
    "mainPhone",
    "phone",
    "phoneNumber",
  ];

  for (const field of phoneFields) {
    for (const value of phoneValues) {
      console.log(
        `Firestore owner lookup: ${field} = ${value}`
      );

      try {
        const snapshot = await db
          .collection("owners")
          .where(field, "==", value)
          .limit(1)
          .get();

        if (!snapshot.empty) {
          console.log(
            `Owner found using ${field}`
          );

          return snapshot.docs[0];
        }
      } catch (error) {
        console.error(
          `Firestore lookup failed for ${field}:`,
          error.message
        );

        throw error;
      }
    }
  }

  console.log(
    "No existing owner found for verified phone."
  );

  return null;
}

/*
|--------------------------------------------------------------------------
| Customer / Owner Check
|--------------------------------------------------------------------------
|
| Flutter sends:
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
  console.log(
    "=================================================="
  );

  console.log(
    "CUSTOMER CHECK REQUEST RECEIVED"
  );

  try {
    /*
     * Firebase check
     */

    if (!firebaseReady) {
      console.error(
        "Firebase Admin SDK is not ready."
      );

      return res.status(503).json({
        success: false,
        message:
          "Firebase backend is not configured",
      });
    }

    /*
     * Access token check
     */

    const accessToken =
      req.body?.accessToken;

    if (
      !accessToken ||
      typeof accessToken !== "string"
    ) {
      console.error(
        "Missing MSG91 accessToken."
      );

      return res.status(400).json({
        success: false,
        message:
          "accessToken is required",
      });
    }

    console.log(
      "MSG91 accessToken received."
    );

    /*
     * Step 1:
     * Verify MSG91 access token.
     */

    const msg91Data =
      await verifyMsg91AccessToken(
        accessToken
      );

    console.log(
      "MSG91 access-token verification successful."
    );

    /*
     * Step 2:
     * Extract verified phone.
     */

    const verifiedPhone =
      extractVerifiedPhone(msg91Data);

    if (!verifiedPhone) {
      console.error(
        "Verified phone was not found in MSG91 response."
      );

      return res.status(401).json({
        success: false,
        message:
          "Unable to determine verified phone number",
      });
    }

    console.log(
      "Verified phone received from MSG91."
    );

    const normalizedPhone =
      normalizeIndianPhone(
        verifiedPhone
      );

    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid verified phone number",
      });
    }

    console.log(
      "Verified phone normalized successfully."
    );

    /*
     * Step 3:
     * Search existing owner.
     */

    const ownerDoc =
      await findOwnerByPhone(
        normalizedPhone
      );

    /*
     |--------------------------------------------------------------------------
     | Existing Owner
     |--------------------------------------------------------------------------
     */

    if (ownerDoc) {
      const data =
        ownerDoc.data();

      console.log(
        "Existing owner account found."
      );

      return res.status(200).json({
        success: true,
        exists: true,

        profileCompleted:
          data.profileCompleted === true,

        ownerId:
          data.ownerId ||
          ownerDoc.id,

        authUid:
          data.authUid ||
          data.uid ||
          null,

        role:
          data.role ||
          "owner",

        phone:
          normalizedPhone,
      });
    }

    /*
     |--------------------------------------------------------------------------
     | New Owner
     |--------------------------------------------------------------------------
     */

    console.log(
      "No existing owner account found."
    );

    return res.status(200).json({
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
      "=================================================="
    );

    console.error(
      "CUSTOMER CHECK ERROR"
    );

    console.error(
      "ERROR NAME:",
      error?.name
    );

    console.error(
      "ERROR MESSAGE:",
      error?.message
    );

    if (error?.stack) {
      console.error(
        "ERROR STACK:",
        error.stack
      );
    }

    console.error(
      "=================================================="
    );

    return res.status(500).json({
      success: false,
      message:
        "Customer check failed",
      error:
        error?.message ||
        "Unknown backend error",
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
