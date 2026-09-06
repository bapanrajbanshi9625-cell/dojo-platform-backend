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

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    service: "Dojo Platform Backend",
    status: "running",
    firebase: firebaseReady,
  });
});

/*
|--------------------------------------------------------------------------
| Normalize Indian Phone Number
|--------------------------------------------------------------------------
*/

function normalizeIndianPhone(phoneNumber) {
  if (!phoneNumber) {
    return null;
  }

  let phone =
    String(phoneNumber).trim();

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

/*
|--------------------------------------------------------------------------
| Mask Phone For Logs
|--------------------------------------------------------------------------
*/

function maskPhone(phoneNumber) {
  if (!phoneNumber) {
    return "unknown";
  }

  const phone =
    String(phoneNumber);

  if (phone.length < 6) {
    return "***";
  }

  return (
    `${phone.substring(0, 3)}` +
    `******` +
    `${phone.substring(
      phone.length - 2,
    )}`
  );
}

/*
|--------------------------------------------------------------------------
| MSG91 Access Token Verification
|--------------------------------------------------------------------------
|
| Flutter sends:
|
| {
|   accessToken: "...",
|   phoneNumber: "+91XXXXXXXXXX"
| }
|
| MSG91 Authkey remains only on Render.
|
|--------------------------------------------------------------------------
*/

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

  const response =
    await fetch(
      "https://api.msg91.com/api/v5/widget/verifyAccessToken",
      {
        method: "POST",
        headers: {
          authkey: authKey,
          "Content-Type":
            "application/json",
          Accept:
            "application/json",
        },
        body: JSON.stringify({
          "access-token":
            accessToken,
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

/*
|--------------------------------------------------------------------------
| Find Owner By Phone
|--------------------------------------------------------------------------
*/

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

        if (
          !snapshot.empty
        ) {
          console.log(
            `Owner found using ${field}.`,
          );

          return snapshot
            .docs[0];
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

/*
|--------------------------------------------------------------------------
| Get Existing Owner Firebase UID
|--------------------------------------------------------------------------
|
| Priority:
|
| 1. authUid
| 2. uid
|
| We DO NOT use ownerId as Firebase UID.
|
|--------------------------------------------------------------------------
*/

function getOwnerFirebaseUid(
  ownerData,
) {
  const authUid =
    ownerData?.authUid
      ?.toString()
      .trim() || "";

  if (authUid) {
    return authUid;
  }

  const uid =
    ownerData?.uid
      ?.toString()
      .trim() || "";

  if (uid) {
    return uid;
  }

  return "";
}

/*
|--------------------------------------------------------------------------
| Create Firebase Custom Token
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| This token uses the EXISTING owner's Firebase UID.
|
| Example:
|
| ownerId:
| OWN26SF0041
|
| old authUid:
| 0fQ8shKj4MY7DnyAQevWvdK5PYH3
|
| Custom token UID:
| 0fQ8shKj4MY7DnyAQevWvdK5PYH3
|
| Therefore Flutter will authenticate as the same
| Firebase identity instead of creating a temporary UID.
|
|--------------------------------------------------------------------------
*/

async function createOwnerCustomToken(
  ownerData,
) {
  if (!firebaseReady) {
    throw new Error(
      "Firebase Admin SDK is not ready.",
    );
  }

  const firebaseUid =
    getOwnerFirebaseUid(
      ownerData,
    );

  if (!firebaseUid) {
    throw new Error(
      "Existing owner does not have authUid or uid.",
    );
  }

  const ownerId =
    ownerData?.ownerId
      ?.toString()
      .trim() || "";

  const role =
    ownerData?.role
      ?.toString()
      .trim() || "owner";

  console.log(
    "Creating Firebase custom token.",
  );

  console.log(
    "Existing Firebase UID:",
    firebaseUid,
  );

  console.log(
    "Existing Owner ID:",
    ownerId,
  );

  const additionalClaims = {
    role: role,
    accountType: "owner",

    ...(ownerId
      ? {
          ownerId: ownerId,
        }
      : {}),
  };

  const customToken =
    await admin
      .auth()
      .createCustomToken(
        firebaseUid,
        additionalClaims,
      );

  console.log(
    "Firebase custom token created successfully.",
  );

  return customToken;
}

/*
|--------------------------------------------------------------------------
| Customer / Owner Check
|--------------------------------------------------------------------------
*/

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
      /*
       * Firebase
       */

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

      /*
       * Request body
       */

      const accessToken =
        req.body?.accessToken;

      const phoneNumber =
        req.body?.phoneNumber;

      /*
       * Access token
       */

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

      /*
       * Phone number
       */

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

      /*
       * STEP 1
       * Verify MSG91 access token.
       */

      await verifyMsg91AccessToken(
        accessToken,
      );

      console.log(
        "MSG91 access-token verification successful.",
      );

      /*
       * STEP 2
       * Find existing owner.
       */

      const ownerDoc =
        await findOwnerByPhone(
          normalizedPhone,
        );

      /*
       |--------------------------------------------------------------------------
       | EXISTING OWNER
       |--------------------------------------------------------------------------
       */

      if (ownerDoc) {
        const data =
          ownerDoc.data();

        console.log(
          "Existing owner account found.",
        );

        const ownerId =
          data.ownerId ||
          ownerDoc.id;

        const authUid =
          getOwnerFirebaseUid(
            data,
          );

        const profileCompleted =
          data.profileCompleted ===
          true;

        const role =
          data.role ||
          "owner";

        /*
         * Existing owner must have a Firebase UID.
         *
         * We do NOT create a new temporary UID.
         */

        if (!authUid) {
          console.error(
            "Existing owner has no authUid/uid.",
          );

          return res.status(409).json({
            success: false,
            message:
              "Existing owner account is missing its Firebase authentication identity.",
          });
        }

        /*
         * STEP 3
         * Create Firebase Custom Token
         * using the EXISTING Firebase UID.
         */

        const firebaseCustomToken =
          await createOwnerCustomToken(
            data,
          );

        console.log(
          "Existing owner authentication token ready.",
        );

        console.log(
          "Owner ID:",
          ownerId,
        );

        console.log(
          "Firebase UID:",
          authUid,
        );

        console.log(
          "Profile completed:",
          profileCompleted,
        );

        return res.status(200).json({
          success: true,

          exists: true,

          profileCompleted:
            profileCompleted,

          ownerId:
            ownerId,

          authUid:
            authUid,

          role:
            role,

          phone:
            normalizedPhone,

          /*
           * Flutter will use this token
           * with FirebaseAuth.signInWithCustomToken().
           */
          firebaseCustomToken:
            firebaseCustomToken,
        });
      }

      /*
       |--------------------------------------------------------------------------
       | NEW OWNER
       |--------------------------------------------------------------------------
       */

      console.log(
        "No existing owner account found.",
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

        /*
         * No existing Firebase identity.
         *
         * Therefore no existing-owner
         * custom token is returned.
         */
        firebaseCustomToken: null,
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

/*
|--------------------------------------------------------------------------
| 404 Handler
|--------------------------------------------------------------------------
*/

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      message:
        "Endpoint not found.",
    });
  },
);

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
      `Dojo Platform Backend running on port ${PORT}`,
    );
  },
);
