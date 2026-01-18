const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.PAYMENT_GETWAY_SECRECT);

const admin = require("firebase-admin");

// const serviceAccount = require("./assetverse-firebase-adminsdk.json");

const decoded = Buffer.from(
  process.env.ASSETVERSE_SERVICE_KEY,
  "base64"
).toString("utf8");
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware

app.use(express.json());
app.use(cors());

const jwt = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    console.error("JWT verify failed", err);
    return res.status(401).json({ message: "Invalid token" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.6dcy7ej.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("assetVerse");
    const userCollection = db.collection("users");
    const assignedAssets = db.collection("assignedAssets");
    const assets = db.collection("assets");
    const requests = db.collection("requests");
    const affiliations = db.collection("employeeAffiliations");
    const paymentCollection = db.collection("payment");
    const packageCollection = db.collection("paka");
    const notices = db.collection("notices");
    const noticeReadStatus = db.collection("noticeReadStatus");

    // verifyAdmin

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "hr") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    // register api

    app.post("/requests", jwt, async (req, res) => {
      try {
        const { assetId, userEmail, note = "" } = req.body;

        if (!assetId || !userEmail) {
          return res
            .status(400)
            .send({ message: "assetId and userEmail required" });
        }

        const asset = await assets.findOne({ _id: new ObjectId(assetId) });
        if (!asset) {
          return res.status(404).send({ message: "Asset not found" });
        }

        if ((asset.availableQuantity ?? 0) <= 0) {
          return res.status(400).send({ message: "Out of stock" });
        }

        const requester = await userCollection.findOne({ email: userEmail });
        if (!requester) {
          return res.status(404).send({ message: "User not found" });
        }
        if (
          !requester.companyName ||
          requester.companyName !== asset.companyName
        ) {
          await userCollection.updateOne(
            { email: userEmail },
            {
              $set: {
                companyName: asset.companyName,
                hrEmail: asset.hrEmail,
                affiliatedAt: new Date(),
              },
            }
          );
        }
        const exists = await requests.findOne({
          assetId: new ObjectId(assetId),
          requesterEmail: userEmail,
          requestStatus: "pending",
        });
        if (exists) {
          return res
            .status(409)
            .send({ message: "Already requested (pending)" });
        }

        const doc = {
          assetId: new ObjectId(assetId),
          assetName: asset.productName,
          assetType: asset.productType,
          requesterName: requester.name,
          requesterEmail: requester.email,
          hrEmail: asset.hrEmail,
          companyName: asset.companyName || null,
          requestDate: new Date(),
          requestStatus: "pending",
          note,
          processedBy: null,
        };

        await requests.insertOne(doc);

        res.send({ message: "Request submitted & company affiliated" });
      } catch (err) {
        console.error("REQUEST ERROR:", err);
        res.status(500).send({ message: err.message });
      }
    });

    // hrApprove

    app.patch(
      "/assigned-assets/approve/:id",
      jwt,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;

          const requestDoc = await assignedAssets.findOne({
            _id: new ObjectId(id),
          });
          if (!requestDoc)
            return res.status(404).send({ message: "Request not found" });

          if (requestDoc.status !== "Pending") {
            return res
              .status(400)
              .send({ message: "Only Pending requests can be approved" });
          }
          const hr = await userCollection.findOne({
            email: requestDoc.hrEmail,
          });

          const limit = hr?.packageLimit ?? 5;
          const used = hr?.currentEmployees ?? 0;

          if (used >= limit) {
            return res.status(200).send({
              blocked: true,
              code: "LIMIT_REACHED",
              message: `Employee limit reached (${used}/${limit})`,
            });
          }

          const approveResult = await assignedAssets.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "Approved", approvalDate: new Date() } }
          );

          // Deduct quantity from the asset
          await assets.updateOne(
            { _id: new ObjectId(requestDoc.assetId) },
            { $inc: { quantity: -1 } }
          );

          const employee = await userCollection.findOne({
            email: requestDoc.userEmail,
          });
          if (!employee) {
            return res.status(400).send({
              message:
                "Employee account not found. Ask employee to register first.",
            });
          }

          // Check if employee is already affiliated with this company
          const existingAffiliation = await affiliations.findOne({
            employeeEmail: requestDoc.userEmail,
            companyName: requestDoc.companyName,
            status: "active",
          });

          // Only create new affiliation if not already affiliated with this company
          if (!existingAffiliation && requestDoc.companyName) {
            await affiliations.insertOne({
              employeeEmail: requestDoc.userEmail,
              employeeName: employee.name || employee.displayName || "Unknown",
              hrEmail: requestDoc.hrEmail,
              companyName: requestDoc.companyName,
              joinedAt: new Date(),
              affiliationDate: new Date(),
              status: "active",
            });
            await userCollection.updateOne(
              { email: requestDoc.hrEmail },
              { $inc: { currentEmployees: 1 } }
            );
          }

          res.send({ message: "Approved successfully", approveResult });
        } catch (err) {
          res.status(500).send({ message: "Server error", error: err.message });
        }
      }
    );

    // Return Asset
    app.patch(
      "/assigned-assets/return/:id",
      jwt,
      verifyAdmin,
      async (req, res) => {
        const assigned = await assignedAssets.findOne({
          _id: new ObjectId(id),
        });

        if (!assigned)
          return res.status(404).send({ message: "Assigned asset not found" });
        if (assigned.status === "returned")
          return res.status(400).send({ message: "Asset already returned" });

        await assignedAssets.updateOne(
          { _id: assigned._id },
          { $set: { status: "returned", returnDate: new Date() } }
        );

        if (assigned.assetType === "Returnable") {
          await assets.updateOne(
            { _id: new ObjectId(assigned.assetId) },
            { $inc: { availableQuantity: 1 } }
          );
        }

        if (assigned.requestId) {
          await requests.updateOne(
            { _id: new ObjectId(assigned.requestId) },
            { $set: { requestStatus: "returned" } }
          );
        }

        res.send({ message: "Asset returned successfully" });
      }
    );

    app.patch(
      "/assigned-assets/reject/:id",
      jwt,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;

          const requestDoc = await assignedAssets.findOne({
            _id: new ObjectId(id),
          });
          if (!requestDoc)
            return res.status(404).send({ message: "Request not found" });

          if (requestDoc.status !== "Pending") {
            return res
              .status(400)
              .send({ message: "Only Pending requests can be rejected" });
          }

          const result = await assignedAssets.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                status: "Rejected",
                rejectionDate: new Date(),
              },
            }
          );

          res.send({ message: "Rejected", result });
        } catch (err) {
          res.status(500).send({ message: "Server error", error: err.message });
        }
      }
    );

    // hr requerment
    // assetsList
    app.get("/assets/hr", jwt, verifyAdmin, async (req, res) => {
      try {
        const { hrEmail, search = "", page = 1, limit = 10 } = req.query;

        const query = { hrEmail };
        if (search) {
          const regex = new RegExp(search, "i");
          query.productName = { $regex: regex };
        }

        const skip = (Number(page) - 1) * Number(limit);

        const total = await assets.countDocuments(query);
        const result = await assets
          .find(query)
          .sort({ dateAdded: -1 })
          .skip(skip)
          .limit(Number(limit))
          .toArray();

        res.send({
          assets: result,
          total,
          totalPages: Math.ceil(total / limit),
          currentPage: Number(page),
        });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // hrAddAssets
    app.post("/assets", jwt, verifyAdmin, async (req, res) => {
      const body = req.body;

      const assetDoc = {
        productName: body.productName,
        productImage: body.productImage,
        productType: body.productType,
        productQuantity: Number(body.productQuantity),
        availableQuantity: Number(body.productQuantity),
        dateAdded: new Date(),
        hrEmail: body.hrEmail,
        companyName: body.companyName,
      };

      const result = await assets.insertOne(assetDoc);
      res.send({ insertedId: result.insertedId, asset: assetDoc });
    });
    // delete
    app.delete("/assets/:id", jwt, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await assets.deleteOne(query);
      res.send(result);
    });
    app.patch("/assets/:id", jwt, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { productName, productType, productQuantity, productImage } =
          req.body;

        const updateDoc = {
          $set: {
            productName,
            productType,
            productQuantity: Number(productQuantity),
            // simple logic (later you can calculate from assigned assets)
            availableQuantity: Number(productQuantity),
            productImage,
            updatedAt: new Date(),
          },
        };

        const result = await assets.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Asset not found" });
        }

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });
    // chart
    app.get("/hr/analytics", async (req, res) => {
      try {
        const { hrEmail } = req.query;
        if (!hrEmail) {
          return res.status(400).send({ message: "hrEmail required" });
        }

        const typeAgg = await assets
          .aggregate([
            { $match: { hrEmail } },
            {
              $group: {
                _id: "$productType",
                total: { $sum: "$productQuantity" },
              },
            },
          ])
          .toArray();

        const assetTypes = typeAgg.map((t) => ({
          type: t._id,
          value: t.total,
        }));

        // Top requested assets from assignedAssets collection
        const topAssets = await assignedAssets
          .aggregate([
            { $match: { hrEmail } },
            {
              $group: {
                _id: "$assetName",
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 5 },
            {
              $project: {
                _id: 0,
                name: "$_id",
                count: 1,
              },
            },
          ])
          .toArray();

        // Pending requests count
        const pendingRequests = await assignedAssets.countDocuments({
          hrEmail,
          status: "Pending",
        });

        res.send({
          assetTypes,
          topRequestedAssets: topAssets,
          pendingRequests,
        });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    app.get("/assigned-assets/mine", async (req, res) => {
      const { email, search = "", type = "", page = 1, limit = 10 } = req.query;

      const query = {
        userEmail: email,
        status: { $in: ["Approved", "Pending"] },
      };

      if (type) {
        query.assetType = type;
      }

      if (search) {
        query.assetName = { $regex: search, $options: "i" };
      }

      const skip = (Number(page) - 1) * Number(limit);

      const total = await assignedAssets.countDocuments(query);

      const assets = await assignedAssets
        .find(query)
        .sort({ requestDate: -1 })
        .skip(skip)
        .limit(Number(limit))
        .toArray();

      res.send({
        assets,
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: Number(page),
      });
    });

    // available Assets

    app.get("/assets/available", async (req, res) => {
      try {
        const { search = "", type = "", companyName = "" } = req.query;

        const query = {
          availableQuantity: { $gt: 0 },
        };

        if (search) {
          query.productName = { $regex: search, $options: "i" };
        }

        if (type) {
          query.productType = type;
        }

        if (companyName) {
          query.companyName = companyName;
        }

        const result = await assets
          .find(query)
          .sort({ dateAdded: -1 })
          .toArray();

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Get employee's affiliations (for multiple company support)
    app.get("/affiliations", async (req, res) => {
      try {
        const { employeeEmail } = req.query;
        if (!employeeEmail) {
          return res.status(400).send({ message: "employeeEmail required" });
        }

        const data = await affiliations
          .find({ employeeEmail, status: "active" })
          .sort({ affiliationDate: -1 })
          .toArray();

        res.send(data);
      } catch (err) {
        res.status(500).send({ message: "Failed to load affiliations" });
      }
    });

    app.get("/affiliations/unique", async (req, res) => {
      try {
        const data = await affiliations
          .aggregate([
            {
              $group: {
                _id: "$employeeEmail",
                employeeEmail: { $first: "$employeeEmail" },
                employeeName: { $first: "$employeeName" },
                hrEmail: { $first: "$hrEmail" },
                companyName: { $first: "$companyName" },
                affiliationDate: { $last: "$affiliationDate" },
                status: { $first: "$status" },
              },
            },

            { $sort: { affiliationDate: -1 } },
          ])
          .toArray();

        res.send({
          total: data.length,
          employees: data,
        });
      } catch (err) {
        res.status(500).send({ message: "Failed to load unique employees" });
      }
    });
    app.delete("/affiliations/unique/:email", async (req, res) => {
      try {
        const { email } = req.params;
        const { companyName } = req.body;

        if (!email) {
          return res.status(400).send({ message: "Employee email required" });
        }
        if (!companyName) {
          return res.status(400).send({ message: "companyName required" });
        }

        const affiliation = await affiliations.findOne({
          employeeEmail: email,
          companyName,
          status: "active",
        });

        if (!affiliation) {
          return res.status(404).send({ message: "Employee not in team" });
        }

        // Delete from affiliations collection
        await affiliations.deleteOne({ _id: affiliation._id });
        
        // Remove company affiliation from user collection
        await userCollection.updateOne(
          { email: email },
          { 
            $unset: { 
              companyName: "",
              hrEmail: ""
            }
          }
        );
        
        // Decrease HR employee count
        if (affiliation.hrEmail) {
          await userCollection.updateOne(
            { email: affiliation.hrEmail },
            { $inc: { currentEmployees: -1 } }
          );
        }

        res.send({ success: true, message: "Removed from team" });
      } catch (err) {
        res.status(500).send({
          message: "Server error",
          error: err.message,
        });
      }
    });

    // GET: All Packages

    app.get("/packages", jwt, verifyAdmin, async (req, res) => {
      try {
        const packages = await packageCollection
          .find()
          .sort({ employeeLimit: 1 })
          .toArray();
        res.send(packages);
      } catch (e) {
        res.status(500).send({ message: "Failed to fetch packages" });
      }
    });

    //  create stripe payment intent

    app.post("/create-payment-intent", jwt, verifyAdmin, async (req, res) => {
      try {
        const { price, packageName, hrEmail, employeeLimit } = req.body;

        if (!price || !hrEmail || !packageName) {
          return res.status(400).send({ message: "Invalid payment data" });
        }

        const amount = Math.round(Number(price) * 100); // cents
        if (!amount || amount < 50) {
          return res.status(400).send({ message: "Invalid amount" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "usd",
          automatic_payment_methods: { enabled: true }, // ✅ card included
          metadata: {
            packageName,
            hrEmail,
            employeeLimit: String(employeeLimit ?? ""),
          },
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({
          message: "Failed to create payment intent",
          error: err.message,
        });
      }
    });

    //  save payment + update user package immediately

    app.post("/payments", async (req, res) => {
      try {
        const {
          hrEmail,
          packageName,
          employeeLimit,
          amount,
          transactionId,
          status,
        } = req.body;

        if (!hrEmail || !packageName || !transactionId) {
          return res.status(400).send({ message: "Invalid payment payload" });
        }

        // 1) Save payment history
        await paymentCollection.insertOne({
          hrEmail,
          packageName,
          employeeLimit,
          amount,
          transactionId,
          paymentDate: new Date(),
          status: status || "completed",
        });

        // 2) Update user subscription immediately
        await userCollection.updateOne(
          { email: hrEmail },
          {
            $set: {
              subscription: packageName,
              employeeLimit: Number(employeeLimit),
              upgradedAt: new Date(),
            },
          },
          { upsert: false }
        );

        res.send({ success: true });
      } catch (e) {
        res
          .status(500)
          .send({ message: "Payment save failed", error: e.message });
      }
    });

    app.post("/employees", async (req, res) => {
      try {
        const { hrEmail, employeeData } = req.body;

        if (!hrEmail || !employeeData) {
          return res.status(400).send({ message: "Invalid request" });
        }

        const hrUser = await userCollection.findOne({ email: hrEmail });
        if (!hrUser) return res.status(404).send({ message: "HR not found" });

        const limit = Number(hrUser.employeeLimit || 0);

        const currentCount = await affiliations.countDocuments({
          hrEmail,
        });

        if (currentCount >= limit) {
          return res.status(403).send({
            message: "Employee limit reached. Please upgrade your package.",
            currentCount,
            limit,
          });
        }

        const result = await employeeCollection.insertOne({
          hrEmail,
          ...employeeData,
          createdAt: new Date(),
        });

        res.send({ success: true, insertedId: result.insertedId });
      } catch (e) {
        res
          .status(500)
          .send({ message: "Failed to add employee", error: e.message });
      }
    });

    app.get("/users/me", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) return res.status(400).send({ message: "email required" });

        const user = await userCollection.findOne(
          { email },
          { projection: { password: 0 } }
        );
        res.send(user);
      } catch (e) {
        res.status(500).send({ message: "Failed to load user" });
      }
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const users = await userCollection.findOne({ email: user.email });
      if (users) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const userDoc = {
        name: user.displayName,
        email: user.email,
        role: user.role,
        dateOfBirth: user.dateOfBirth,
        profileImage: user.companyLogo || user.profileImage || "",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // HR specific fields
      if (user.role === "hr") {
        userDoc.companyName = user.companyName;
        userDoc.companyLogo = user.companyLogo;
        userDoc.packageLimit = 5;
        userDoc.currentEmployees = 0;
        userDoc.subscription = "basic";
      }

      const result = await userCollection.insertOne(userDoc);
      return res.send({
        result,
        message: "User registered",
        user: userDoc,
        token: "dummy-jwt-token-here",
      });
    });

    app.get("/users/employees", async (req, res) => {
      try {
        const employees = await userCollection
          .find({ role: "employee" })
          .sort({ createdAt: -1 })
          .toArray();

        res.send({
          success: true,
          total: employees.length,
          employees,
        });
      } catch (err) {
        res.status(500).send({
          message: "Failed to load employees",
          error: err.message,
        });
      }
    });

    app.post("/assign_asset", async (req, res) => {
      const body = req.body;

      const assetDoc = {
        assetId: body.assetId,
        userEmail: body.userEmail,
        hrEmail: body.hrEmail,
        companyName: body.companyName,
        assetName: body.assetName,
        assetImage: body.assetImage,
        assetType: body.assetType,
        status: "Pending",
        requestDate: new Date(),
        approvalDate: null,
      };

      const result = await assignedAssets.insertOne(assetDoc);

      const existingMember = await userCollection.findOne({
        email: body.userEmail,
        companyName: body.companyName,
      });

      if (!existingMember) {
        await userCollection.updateOne(
          { email: body.userEmail },
          {
            $set: { companyName: body.companyName, hrEmail: body.hrEmail },
          }
        );
      }

      res.send({
        message: "Asset Assigned",
        insertedId: result.insertedId,
      });
    });

    app.get("/assigned-assets", async (req, res) => {
      const {
        companyName = "",
        hrEmail = "",
        status = "",
        search = "",
        page = 1,
        limit = 10,
      } = req.query;

      const query = {};
      if (companyName) query.companyName = companyName;
      if (hrEmail) query.hrEmail = hrEmail;
      if (status) query.status = status;

      if (search) {
        const regex = new RegExp(search, "i");
        query.$or = [
          { userEmail: { $regex: regex } },
          { assetName: { $regex: regex } },
          { assetType: { $regex: regex } },
        ];
      }

      const skip = (Number(page) - 1) * Number(limit);
      const total = await assignedAssets.countDocuments(query);

      const result = await assignedAssets
        .find(query)
        .sort({ requestDate: -1 })
        .skip(skip)
        .limit(Number(limit))
        .toArray();

      res.send({
        requests: result,
        total,
        totalPages: Math.ceil(total / Number(limit)),
        currentPage: Number(page),
      });
    });

    app.get("/assets/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await assets.findOne({ _id: new ObjectId(id) });
        if (!result)
          return res.status(404).send({ message: "Asset not found" });

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });
    app.post("/assigned-assets/request", async (req, res) => {
      try {
        const {
          assetId,
          userEmail,
          hrEmail,
          companyName,
          note = "",
        } = req.body;

        let validAssetId;
        try {
          validAssetId = new ObjectId(assetId);
        } catch (err) {
          return res.status(400).send({ message: "Invalid assetId" });
        }

        if (!userEmail || !companyName) {
          return res
            .status(400)
            .send({ message: "userEmail and companyName required" });
        }

        const asset = await assets.findOne({ _id: validAssetId });
        if (!asset) return res.status(404).send({ message: "Asset not found" });

        if ((asset.availableQuantity ?? 0) <= 0) {
          return res.status(400).send({ message: "Asset out of stock" });
        }

        // Optional: prevent duplicate pending request for same asset by same user
        const exists = await assignedAssets.findOne({
          assetId,
          userEmail,
          status: "Pending",
        });
        if (exists)
          return res
            .status(409)
            .send({ message: "You already requested this asset (Pending)" });

        const doc = {
          assetId,
          userEmail,
          hrEmail: hrEmail || asset.hrEmail || "",
          companyName: companyName || asset.companyName || "",

          assetName: asset.productName,
          assetImage: asset.productImage,
          assetType: asset.productType,

          note,
          status: "Pending",
          requestDate: new Date(),
          approvalDate: null,
          rejectionDate: null,
        };

        const result = await assignedAssets.insertOne(doc);
        res.send({
          message: "Request submitted",
          insertedId: result.insertedId,
          request: doc,
        });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // emplee

    app.get("/team", async (req, res) => {
      const users = await userCollection
        .find({ companyName: { $exists: true } })
        .project({
          name: 1,
          email: 1,
          profileImage: 1,
          companyName: 1,
          dateOfBirth: 1,
          position: 1,
        })
        .toArray();
      res.send(users);
    });
    app.get("/company/:companyName/team", async (req, res) => {
      const { companyName } = req.params;
      const members = await userCollection
        .find({ companyName })
        .project({
          name: 1,
          email: 1,
          companyName: 1,
          profileImage: 1,
          dateOfBirth: 1,
          position: 1,
        })
        .toArray();
      console.log(members);
      res.send(members);
    });

    app.get("/hr/stats", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "email is required" });

      const hr = await userCollection.findOne({ email });
      if (!hr) return res.status(404).send({ message: "HR not found" });

      res.send({
        packageLimit: hr.packageLimit ?? 0,
        currentEmployees: hr.currentEmployees ?? 0,
        companyName: hr.companyName ?? "",
        hrEmail: hr.email,
      });
    });

    app.get("/users/:email/profile", async (req, res) => {
      try {
        const email = String(req.params.email || "")
          .trim()
          .toLowerCase();

        const userDoc = await userCollection.findOne({ email });
        if (!userDoc)
          return res.status(404).send({ message: "User not found" });

        res.send({
          name: userDoc.name || "",
          email: userDoc.email,
          role: userDoc.role || "",
          phone: userDoc.phone || "",
          profileImage: userDoc.profileImage || "",

          // read-only fields (affiliation)
          companyName: userDoc.companyName || "",
          hrEmail: userDoc.hrEmail || "",

          createdAt: userDoc.createdAt || null,
          updatedAt: userDoc.updatedAt || null,
        });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    app.patch("/users/:email/profile", async (req, res) => {
      try {
        const email = String(req.params.email || "")
          .trim()
          .toLowerCase();
        const { name, phone, profileImage } = req.body;

        // basic validation
        // if (!name || !String(name).trim()) {
        //   return res.status(400).send({ message: "name is required" });
        // }

        const updateDoc = {
          $set: {
            name: String(name).trim(),
            phone: String(phone || "").trim(),
            profileImage: String(profileImage || "").trim(),
            updatedAt: new Date(),
          },
        };

        const result = await userCollection.updateOne({ email }, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ message: "Profile updated", result });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // get user role

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      if (!user) {
        return res.status(404).send({ role: null });
      }

      res.send({ role: user.role });
    });

    // ============ NOTICE BOARD SYSTEM ============

    // Create notice (HR only)
    app.post("/notices", jwt, verifyAdmin, async (req, res) => {
      try {
        const { title, content, priority = "medium" } = req.body;
        const hrEmail = req.decoded_email;

        // Validation
        if (!title || !content) {
          return res
            .status(400)
            .send({ message: "Title and content required" });
        }
        if (title.length < 5) {
          return res
            .status(400)
            .send({ message: "Title must be at least 5 characters" });
        }
        if (content.length < 10) {
          return res
            .status(400)
            .send({ message: "Content must be at least 10 characters" });
        }
        if (!["high", "medium", "low"].includes(priority)) {
          return res
            .status(400)
            .send({ message: "Priority must be high, medium, or low" });
        }

        // Get HR's company
        const hr = await userCollection.findOne({ email: hrEmail });
        if (!hr || !hr.companyName) {
          return res.status(400).send({ message: "HR company not found" });
        }

        const noticeDoc = {
          title,
          content,
          priority,
          companyName: hr.companyName,
          hrEmail,
          createdAt: new Date(),
          updatedAt: null,
        };

        const result = await notices.insertOne(noticeDoc);
        res.send({
          message: "Notice created",
          insertedId: result.insertedId,
          notice: noticeDoc,
        });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Get notices by company
    app.get("/notices", async (req, res) => {
      try {
        const { companyName, hrEmail } = req.query;

        const query = {};
        if (companyName) query.companyName = companyName;
        if (hrEmail) query.hrEmail = hrEmail;

        const result = await notices
          .find(query)
          .sort({
            priority: 1, // Will need custom sort
            createdAt: -1,
          })
          .toArray();

        // Custom sort: high=0, medium=1, low=2, then by date
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        result.sort((a, b) => {
          const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
          if (pDiff !== 0) return pDiff;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Get unread count for employee (MUST be before /notices/:id)
    app.get("/notices/unread-count", async (req, res) => {
      try {
        const { email, companyName } = req.query;

        if (!email || !companyName) {
          return res
            .status(400)
            .send({ message: "email and companyName required" });
        }

        // Get all notices for company
        const companyNotices = await notices.find({ companyName }).toArray();
        const noticeIds = companyNotices.map((n) => n._id);

        // Get read notices for this employee
        const readNotices = await noticeReadStatus
          .find({
            noticeId: { $in: noticeIds },
            employeeEmail: email,
          })
          .toArray();

        const unreadCount = companyNotices.length - readNotices.length;

        res.send({ unreadCount, total: companyNotices.length });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Get notices with read status for employee (MUST be before /notices/:id)
    app.get("/notices/employee", async (req, res) => {
      try {
        const { email, companyName } = req.query;

        if (!email || !companyName) {
          return res
            .status(400)
            .send({ message: "email and companyName required" });
        }

        // Get all notices for company
        const companyNotices = await notices.find({ companyName }).toArray();

        // Get read status for this employee
        const readStatuses = await noticeReadStatus
          .find({ employeeEmail: email })
          .toArray();

        const readNoticeIds = new Set(
          readStatuses.map((r) => r.noticeId.toString())
        );

        // Add isRead flag to each notice
        const noticesWithStatus = companyNotices.map((notice) => ({
          ...notice,
          isRead: readNoticeIds.has(notice._id.toString()),
        }));

        // Sort by priority then date
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        noticesWithStatus.sort((a, b) => {
          const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
          if (pDiff !== 0) return pDiff;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });

        res.send(noticesWithStatus);
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Get single notice (dynamic route - MUST be after specific routes)
    app.get("/notices/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const notice = await notices.findOne({ _id: new ObjectId(id) });

        if (!notice) {
          return res.status(404).send({ message: "Notice not found" });
        }

        res.send(notice);
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Update notice (HR only)
    app.patch("/notices/:id", jwt, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const hrEmail = req.decoded_email;
        const { title, content, priority } = req.body;

        const notice = await notices.findOne({ _id: new ObjectId(id) });
        if (!notice) {
          return res.status(404).send({ message: "Notice not found" });
        }

        // Check ownership
        if (notice.hrEmail !== hrEmail) {
          return res
            .status(403)
            .send({ message: "Cannot edit notices from other companies" });
        }

        // Validation
        if (title && title.length < 5) {
          return res
            .status(400)
            .send({ message: "Title must be at least 5 characters" });
        }
        if (content && content.length < 10) {
          return res
            .status(400)
            .send({ message: "Content must be at least 10 characters" });
        }
        if (priority && !["high", "medium", "low"].includes(priority)) {
          return res
            .status(400)
            .send({ message: "Priority must be high, medium, or low" });
        }

        const updateDoc = {
          $set: {
            ...(title && { title }),
            ...(content && { content }),
            ...(priority && { priority }),
            updatedAt: new Date(),
          },
        };

        const result = await notices.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );
        res.send({ message: "Notice updated", result });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Delete notice (HR only) - cascade delete read status
    app.delete("/notices/:id", jwt, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const hrEmail = req.decoded_email;

        const notice = await notices.findOne({ _id: new ObjectId(id) });
        if (!notice) {
          return res.status(404).send({ message: "Notice not found" });
        }

        // Check ownership
        if (notice.hrEmail !== hrEmail) {
          return res
            .status(403)
            .send({ message: "Cannot delete notices from other companies" });
        }

        // Delete notice
        await notices.deleteOne({ _id: new ObjectId(id) });

        // Cascade delete read status records
        await noticeReadStatus.deleteMany({ noticeId: new ObjectId(id) });

        res.send({ message: "Notice deleted" });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Mark notice as read
    app.post("/notices/:id/read", async (req, res) => {
      try {
        const noticeId = req.params.id;
        const { employeeEmail } = req.body;

        if (!employeeEmail) {
          return res.status(400).send({ message: "employeeEmail required" });
        }

        const notice = await notices.findOne({ _id: new ObjectId(noticeId) });
        if (!notice) {
          return res.status(404).send({ message: "Notice not found" });
        }

        // Check if already read
        const existing = await noticeReadStatus.findOne({
          noticeId: new ObjectId(noticeId),
          employeeEmail,
        });

        if (existing) {
          return res.send({
            message: "Already marked as read",
            alreadyRead: true,
          });
        }

        // Mark as read
        await noticeReadStatus.insertOne({
          noticeId: new ObjectId(noticeId),
          employeeEmail,
          readAt: new Date(),
        });

        res.send({ message: "Marked as read" });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("assetVerse  is shifting!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
