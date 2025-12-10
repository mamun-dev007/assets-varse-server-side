const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const port = process.env.PORT || 3000;
const crypto = require("crypto");
const { profile } = require("console");

// middleware
app.use(express.json());
app.use(cors());

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

    // register api
    app.post("/users", async (req, res) => {
      const body = req.body;
      const users = await userCollection.findOne({ email: body.email });
      if (users) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const userDoc = {
        name: body.displayName,
        email: body.email,
        role: body.role,
        dateOfBirth: body.dateOfBirth,
        profileImage: body.companyLogo || body.profileImage || "",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // HR specific fields
      if (body.role === "hr") {
        userDoc.companyName = body.companyName;
        userDoc.companyLogo = body.companyLogo;
        userDoc.packageLimit = 5;
        userDoc.currentEmployees = 0;
        userDoc.subscription = "basic";
      }
      const result = await userCollection.insertOne(userDoc);
      return res.send({
        result,
        message: "User registered",
        user: userDoc,
        //  token: "dummy-jwt-token-here"
      });
    });

    app.post("/assign_asset", async (req, res) => {
      const body = req.body;

      const assetDoc = {
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

    //  GET MY ASSETS (Employee)

    app.get("/assigned-assets/mine", async (req, res) => {
      const { email, search = "", type = "" } = req.query;
      const query = { userEmail: email };

      if (type) query.assetType = type;
      const regex = new RegExp(search, "i");

      const result = await assignedAssets
        .find({
          ...query,
          assetName: { $regex: regex },
        })
        .sort({ requestDate: -1 })
        .toArray();

      res.send(result);
    });

    //  APPROVE ASSET (HR)

    app.patch("/assigned-assets/approve/:id", async (req, res) => {
      const id = req.params.id;

      const result = await assignedAssets.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "Approved",
            approvalDate: new Date(),
          },
        }
      );

      res.send(result);
    });

    //   RETURN ASSET (EMPLOYEE)

    app.patch("/assigned-assets/return/:id", async (req, res) => {
      const id = req.params.id;

      const update = await assignedAssets.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "Returned",
            returnDate: new Date(),
          },
        }
      );

      res.send(update);
    });

    //  GET ALL ASSIGNED ASSETS (HR)

    app.get("/assigned-assets", async (req, res) => {
      const result = await assignedAssets.find().toArray();
      res.send(result);
    });

    // emplee
    app.get("/team", async (req, res) => {
      const users = await userCollection
        .find({ companyName: { $exists: true,  } })
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

  res.send(members);
});


// assets
app.get("/assets", async (req, res) => {
  const { search = "", type = "", companyName = "", hrEmail = "" } = req.query;

  const query = {};

  if (companyName) query.companyName = companyName;
  if (hrEmail) query.hrEmail = hrEmail;

  if (type) query.productType = type; 
  if (search) {
    const regex = new RegExp(search, "i");
    query.$or = [{ productName: { $regex: regex } }];
  }

  const result = await assets
    .find(query)
    .sort({ dateAdded: -1 })
    .toArray();

  res.send(result);
});

app.post("/assets", async (req, res) => {
  const body = req.body;

  const assetDoc = {
    productName: body.productName,
    productImage: body.productImage,
    productType: body.productType, 
    productQuantity: Number(body.productQuantity || 0),
    availableQuantity: Number(body.productQuantity || 0),

    dateAdded: new Date(),
    hrEmail: body.hrEmail,
    companyName: body.companyName,
  };

  const result = await assets.insertOne(assetDoc);
  res.send({ insertedId: result.insertedId, asset: assetDoc });
});

app.delete("/assets/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await assets.deleteOne(query);
      res.send(result);
    });

app.get("/assets/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const result = await assets.findOne({ _id: new ObjectId(id) });
    if (!result) return res.status(404).send({ message: "Asset not found" });

    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error", error: err.message });
  }
});

app.patch("/assets/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { productName, productType, productQuantity, productImage } = req.body;

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

    const result = await assets.updateOne({ _id: new ObjectId(id) }, updateDoc);

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Asset not found" });
    }

    res.send(result);
  } catch (err) {
    res.status(500).send({ message: "Server error", error: err.message });
  }
});














    // profile api
 app.patch("/users/:email/profile", async (req, res) => {
  const email = req.params.email;
  const filter = { email };

  const { name, phone, profileImage } = req.body;

  const updateDoc = {
    $set: {
      name,
      phone,
      profileImage,
      
    },
  };

  const result = await userCollection.updateOne(filter, updateDoc);
  res.send(result);
});

    // get user role

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user) return res.send({ role: null });
      res.send({ role: user.role });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
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
