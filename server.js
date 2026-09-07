const express = require("express");
const admin = require("firebase-admin");

const app = express();

app.use(express.json());

let firebaseReady = false;

// ============================================================
// FIREBASE ADMIN INITIALIZATION
// ============================================================

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
        privateKey:
          process.env.FIREBASE_PRIVATE_KEY.replace(
            /\\n/g,
            "\n",
          ),
      }),
    });

    firebaseReady = true;

    console.log(
      "Firebase Admin SDK initialized.",
    );
  } else {
    console.log(
      "Firebase credentials are not configured yet.",
    );
  }
} catch (error) {
  console.error(
    "Firebase initialization failed:",
    error.message,
  );
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    service: "Dojo Platform Backend",
    status: "running",
    firebase: firebaseReady,
  });
});

// ============================================================
// PHONE NORMALIZATION
// ============================================================

function normalizeIndianPhone(phoneNumber) {
  if (!phoneNumber) {
    return null;
  }

  let phone = String(phoneNumber).trim();

  phone = phone.replace(/\s+/g, "");
  phone = phone.replace(/-/g, "");

  if (phone.startsWith("+91")) {
    phone = phone.substring(3);
  } else if (
    phone.startsWith("91") &&
    phone.length === 12
  ) {
    phone = phone.substring(2);
  }

  if (!/^[6-9]\d{9}$/.test(phone)) {
    return null;
  }

  return `+91${phone}`;
}

// ============================================================
// PHONE MASKING
// ============================================================

function maskPhone(phoneNumber) {
  if (!phoneNumber) {
    return "unknown";
  }

  const phone = String(phoneNumber);

  if (phone.length < 6) {
    return "***";
  }

  return `${phone.substring(
    0,
    3,
  )}******${phone.substring(
    phone.length - 2,
  )}`;
}

// ============================================================
// MSG91 ACCESS TOKEN VERIFICATION
// ============================================================

async function verifyMsg91AccessToken(
  accessToken,
) {
  const authKey =
    process.env.MSG91_AUTH_KEY;

  if (!authKey) {
    throw new Error(
      "MSG91_AUTH_KEY is not configured on Render.",
    );
  }

  if (
    !accessToken ||
    typeof accessToken !== "string"
  ) {
    throw new Error(
      "MSG91 access token is missing.",
    );
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
    },
  );

  const text =
    await response.text();

  let data = {};

  try {
    data = JSON.parse(text);
  } catch (_) {
    data = {
      raw: text,
    };
  }

  console.log(
    "MSG91 ACCESS TOKEN STATUS:",
    response.status,
  );

  if (
    data &&
    typeof data === "object"
  ) {
    console.log(
      "MSG91 RESPONSE KEYS:",
      Object.keys(data),
    );
  }

  if (!response.ok) {
    throw new Error(
      `MSG91 access-token verification failed with status ${response.status}.`,
    );
  }

  return data;
}

// ============================================================
// FIND EXISTING OWNER
// ============================================================

async function findOwnerByPhone(
  phoneNumber,
) {
  if (!firebaseReady) {
    throw new Error(
      "Firebase Admin SDK is not ready.",
    );
  }

  const normalizedPhone =
    normalizeIndianPhone(
      phoneNumber,
    );

  if (!normalizedPhone) {
    return null;
  }

  const db =
    admin.firestore();

  const cleanTenDigit =
    normalizedPhone.substring(3);

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

  for (
    const field of phoneFields
  ) {
    for (
      const value of phoneValues
    ) {
      try {
        console.log(
          `Firestore owner lookup: ${field}`,
        );

        const snapshot =
          await db
            .collection("owners")
            .where(
              field,
              "==",
              value,
            )
            .limit(1)
            .get();

        if (!snapshot.empty) {
          console.log(
            `Owner found using ${field}.`,
          );

          return snapshot.docs[0];
        }
      } catch (error) {
        console.error(
          `Firestore lookup failed for ${field}:`,
          error.message,
        );

        throw error;
      }
    }
  }

  console.log(
    "No existing owner found for phone.",
  );

  return null;
}

// ============================================================
// CREATE FIREBASE CUSTOM TOKEN
// ============================================================

async function createOwnerFirebaseCustomToken(
  ownerData,
  ownerDocumentId,
) {
  if (!firebaseReady) {
    throw new Error(
      "Firebase Admin SDK is not ready.",
    );
  }

  const ownerAuthUid =
    String(
      ownerData.authUid ||
        ownerData.uid ||
        "",
    ).trim();

  if (!ownerAuthUid) {
    throw new Error(
      "Existing owner does not have authUid or uid.",
    );
  }

  const ownerId =
    String(
      ownerData.ownerId ||
        ownerDocumentId ||
        "",
    ).trim();

  const role =
    String(
      ownerData.role ||
        "owner",
    ).trim();

  console.log(
    "Creating Firebase custom token for existing owner.",
  );

  console.log(
    "Existing owner authUid:",
    ownerAuthUid,
  );

  console.log(
    "Existing owner ownerId:",
    ownerId,
  );

  const customToken =
    await admin
      .auth()
      .createCustomToken(
        ownerAuthUid,
        {
          role: role,
          ownerId: ownerId,
        },
      );

  return customToken;
}

// ============================================================
// CUSTOMER CHECK
// ============================================================

app.post(
  "/customer/check",
  async (req, res) => {
    console.log(
      "==================================================",
    );

    console.log(
      "CUSTOMER CHECK REQUEST RECEIVED",
    );

    try {
      // ======================================================
      // FIREBASE CHECK
      // ======================================================

      if (!firebaseReady) {
        console.error(
          "Firebase Admin SDK is not ready.",
        );

        return res.status(503).json({
          success: false,
          message:
            "Firebase backend is not configured.",
        });
      }

      // ======================================================
      // REQUEST DATA
      // ======================================================

      const accessToken =
        req.body?.accessToken;

      const phoneNumber =
        req.body?.phoneNumber;

      // ======================================================
      // ACCESS TOKEN VALIDATION
      // ======================================================

      if (
        !accessToken ||
        typeof accessToken !==
          "string"
      ) {
        console.error(
          "Missing MSG91 accessToken.",
        );

        return res.status(400).json({
          success: false,
          message:
            "accessToken is required.",
        });
      }

      // ======================================================
      // PHONE VALIDATION
      // ======================================================

      if (
        !phoneNumber ||
        typeof phoneNumber !==
          "string"
      ) {
        console.error(
          "Missing phoneNumber.",
        );

        return res.status(400).json({
          success: false,
          message:
            "phoneNumber is required.",
        });
      }

      // ======================================================
      // NORMALIZE PHONE
      // ======================================================

      const normalizedPhone =
        normalizeIndianPhone(
          phoneNumber,
        );

      if (!normalizedPhone) {
        console.error(
          "Invalid Indian phone number.",
        );

        return res.status(400).json({
          success: false,
          message:
            "Invalid Indian phone number.",
        });
      }

      console.log(
        "Customer phone:",
        maskPhone(
          normalizedPhone,
        ),
      );

      // ======================================================
      // 1. VERIFY MSG91 ACCESS TOKEN
      // ======================================================

      const msg91Data =
        await verifyMsg91AccessToken(
          accessToken,
        );

      console.log(
        "MSG91 access-token verification successful.",
      );

      console.log(
        "MSG91 verified response:",
        JSON.stringify(
          msg91Data,
        ),
      );

      // ======================================================
      // 2. FIND EXISTING OWNER
      // ======================================================

      console.log(
        "Using verified login phone for owner lookup.",
      );

      const ownerDoc =
        await findOwnerByPhone(
          normalizedPhone,
        );

      // ======================================================
      // 3. EXISTING OWNER
      // ======================================================

      if (ownerDoc) {
        const data =
          ownerDoc.data();

        // ----------------------------------------------------
        // PERMANENT OWNER ID
        // ----------------------------------------------------

        const ownerId =
          data.ownerId ||
          ownerDoc.id;

        // ----------------------------------------------------
        // ORIGINAL FIREBASE AUTH UID
        // ----------------------------------------------------

        const authUid =
          data.authUid ||
          data.uid ||
          null;

        // ----------------------------------------------------
        // EXACT FIRESTORE DOCUMENT ID
        // ----------------------------------------------------

        const ownerDocumentId =
          ownerDoc.id;

        console.log(
          "Existing owner account found.",
        );

        console.log(
          "OWNER DOCUMENT:",
          ownerDocumentId,
        );

        console.log(
          "OWNER ID:",
          ownerId,
        );

        console.log(
          "AUTH UID:",
          authUid,
        );

        // ----------------------------------------------------
        // AUTH UID REQUIRED
        // ----------------------------------------------------

        if (!authUid) {
          console.error(
            "Existing owner has no authUid/uid.",
          );

          return res.status(409).json({
            success: false,

            exists: true,

            message:
              "Existing owner account is missing Firebase authUid.",
          });
        }

        // ----------------------------------------------------
        // IMPORTANT
        //
        // Use the ORIGINAL Firebase UID.
        //
        // No anonymous account.
        // No temporary UID.
        // No phoneAccounts document.
        // No new owner document.
        // ----------------------------------------------------

        const firebaseCustomToken =
          await createOwnerFirebaseCustomToken(
            data,
            ownerDocumentId,
          );

        console.log(
          "Firebase custom token created successfully.",
        );

        // ----------------------------------------------------
        // EXISTING OWNER RESPONSE
        //
        // ownerDocumentId is REQUIRED by Flutter.
        // ----------------------------------------------------

        return res.status(200).json({
          success: true,

          exists: true,

          profileCompleted:
            data.profileCompleted ===
            true,

          isActive:
            data.isActive !== false,

          // EXACT FIRESTORE DOCUMENT ID
          ownerDocumentId:
            ownerDocumentId,

          // PERMANENT BUSINESS OWNER ID
          ownerId:
            ownerId,

          // ORIGINAL FIREBASE AUTH UID
          authUid:
            authUid,

          role:
            data.role ||
            "owner",

          phone:
            normalizedPhone,

          firebaseCustomToken:
            firebaseCustomToken,
        });
      }

      // ======================================================
      // 4. NEW OWNER
      // ======================================================

      console.log(
        "No existing owner account found.",
      );

      return res.status(200).json({
        success: true,

        exists: false,

        profileCompleted: false,

        isActive: true,

        ownerDocumentId: null,

        ownerId: null,

        authUid: null,

        role: "owner",

        phone:
          normalizedPhone,

        firebaseCustomToken:
          null,
      });
    } catch (error) {
      console.error(
        "==================================================",
      );

      console.error(
        "CUSTOMER CHECK ERROR",
      );

      console.error(
        "ERROR NAME:",
        error?.name ||
          "UnknownError",
      );

      console.error(
        "ERROR MESSAGE:",
        error?.message ||
          "Unknown backend error.",
      );

      console.error(
        "==================================================",
      );

      return res.status(500).json({
        success: false,

        message:
          "Customer check failed.",

        error:
          error?.message ||
          "Unknown backend error.",
      });
    }
  },
);

// ============================================================
// 404 HANDLER
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      message:
        "Endpoint not found.",
    });
  },
);

// ============================================================
// SERVER START
// ============================================================

const PORT =
  process.env.PORT || 10000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Dojo Platform Backend running on port ${PORT}`,
    );
  },
);
