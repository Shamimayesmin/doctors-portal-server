const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 5000;
const jwt = require("jsonwebtoken");
require("dotenv").config();

// stripe key
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

// midleware
app.use(cors());
app.use(express.json());

//docPortal
//wfZzaDlT3qLxT9cb

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ui8slz3.mongodb.net/?retryWrites=true&w=majority`;
// console.log(uri);
const client = new MongoClient(uri, {
	useNewUrlParser: true,
	useUnifiedTopology: true,
	serverApi: ServerApiVersion.v1,
});

// jwt function
function verifyJwt(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader) {
		return res.status(401).send("unauthorized access");
	}
	const token = authHeader.split(" ")[1];

	jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
		if (err) {
			return res.status(403).send({ message: "forbidden access" });
		}
		req.decoded = decoded;
		next();
	});
}

async function run() {
	try {
		const appointmentOptionCollection = client
			.db("doctorsPortal")
			.collection("appointmentOptions");
		const bookingsCollection = client
			.db("doctorsPortal")
			.collection("bookings");
		const usersCollection = client.db("doctorsPortal").collection("users");
		const doctorsCollection = client.db("doctorsPortal").collection("doctors");
		const paymentCollection = client.db("doctorsPortal").collection("payments");

		//Note : make sure you use verifyAdmin after verifyJwt
		const verifyAdmin = async (req, res, next) => {
			const decodedEmail = req.decoded.email;
			const query = { email: decodedEmail };
			const user = await usersCollection.findOne(query);
			if (user?.role !== "admin") {
				return res.status(403).send({ message: "forbidden access" });
			}
			next();
		};
		// use aggregate to query multiple collection and then merge data
		app.get("/appointmentOptions", async (req, res) => {
			const date = req.query.date;
			// console.log(date);
			const query = {};
			const options = await appointmentOptionCollection.find(query).toArray();

			// get the booking of the provided date
			const bookingQuery = { appointmentDate: date };
			const alreadyBooked = await bookingsCollection
				.find(bookingQuery)
				.toArray();

			// code carefuly : book kora options gula pawa
			options.forEach((option) => {
				const optionBooked = alreadyBooked.filter(
					(book) => book.treatment === option.name
				);
				// se option theke specific booked  pawa
				const bookedSlots = optionBooked.map((book) => book.slot);
				const remainingSlots = option.slots.filter(
					(slot) => !bookedSlots.includes(slot)
				);
				option.slots = remainingSlots;
			});
			res.send(options);
		});

		// optional :
		app.get("/v2/appointmentOptions", async (req, res) => {
			const date = req.query.date;
			const options = await appointmentOptionCollection
				.aggregate([
					{
						$lookup: {
							from: "bookings",
							localField: "name",
							foreignField: "treatment",
							pipeline: [
								{
									$match: {
										$expr: {
											$eq: ["$appointmentDate", date],
										},
									},
								},
							],
							as: "booked",
						},
					},
					{
						$project: {
							name: 1,
							price: 1,
							slots: 1,
							booked: {
								$map: {
									input: "$booked",
									as: "book",
									in: "$$book.slot",
								},
							},
						},
					},
					{
						$project: {
							name: 1,
							price: 1,
							slots: {
								$setDifference: ["$slots", "$booked"],
							},
						},
					},
				])
				.toArray();
			res.send(options);
		});

		// add a doctor specialty :
		app.get("/appointmentSpecialty", async (req, res) => {
			const query = {};
			const result = await appointmentOptionCollection
				.find(query)
				.project({ name: 1 })
				.toArray();
			res.send(result);
		});

		/**
		 * API naming convention
		 * app.get('/bookings')
		 * app.get('/bookings/:id')
		 * app.post('/bookings')
		 * app.patch('/bookings/:id')
		 * app.delete('bookings/:id')
		 *
		 */

		// get booking
		app.get("/bookings", verifyJwt, async (req, res) => {
			const email = req.query.email;

			// jwt verify
			const decodedEmail = req.decoded.email;

			if (email !== decodedEmail) {
				return res.status(403).send({ message: "forbidden access" });
			}

			const query = { email: email };
			const bookings = await bookingsCollection.find(query).toArray();
			res.send(bookings);
		});

		// payment for specific(id) booking
		app.get("/bookings/:id", async (req, res) => {
			const id = req.params.id;
			const query = { _id: ObjectId(id) };
			const booking = await bookingsCollection.findOne(query);
			res.send(booking);
		});

		// booking api
		app.post("/bookings", async (req, res) => {
			const booking = req.body;
			console.log(booking);
			// restiction on booking
			const query = {
				appointmentDate: booking.appointmentDate,
				email: booking.email,
				treatment: booking.treatment,
			};
			const alreadyBooked = await bookingsCollection.find(query).toArray();
			if (alreadyBooked.length) {
				const message = `You already booked ${booking.appointmentDate}`;
				return res.send({ acknowledged: false, message });
			}

			//-----------------------------
			const result = await bookingsCollection.insertOne(booking);
			res.send(result);
		});

		// payment api
		app.post("/create-payment-intent", async (req, res) => {
			const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

			// Create a PaymentIntent with the order amount and currency
			const paymentIntent = await stripe.paymentIntents.create({
				amount: amount,
				currency: "usd",
				"payment_method_types" : [
                    "card"
                ]
			});

			res.send({
				clientSecret: paymentIntent.client_secret,
			});
		});


        // payment post 
        app.post('/payments', async(req, res) =>{
            const payment = req.body;
            const result = await paymentCollection.insertOne(payment);
            const id = payment.bookingId 
            const filter = {_id : ObjectId(id)}
            const updatedDoc = {
                $set : {
                    paid : true,
                    transactionId : payment.transactionId
                }
            }
            const updateResult = await bookingsCollection.updateOne(filter, updatedDoc)
            res.send(result)
        })
		// jwt token
		app.get("/jwt", async (req, res) => {
			const email = req.query.email;
			const query = { email: email };
			const user = await usersCollection.findOne(query);
			if (user) {
				const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
					expiresIn: "1d",
				});
				return res.send({ accessToken: token });
			}
			// console.log(user);
			res.status(403).send({ accessToken: "" });
		});

		// user get
		app.get("/users", async (req, res) => {
			const query = {};
			const users = await usersCollection.find(query).toArray();
			res.send(users);
		});

		// check admin
		app.get("/users/admin/:email", async (req, res) => {
			const email = req.params.email;
			const query = { email };
			const user = await usersCollection.findOne(query);
			res.send({ isAdmin: user?.role === "admin" });
		});

		// user create
		app.post("/users", async (req, res) => {
			const user = req.body;
			const result = await usersCollection.insertOne(user);
			res.send(result);
		});

		// update user :
		app.put("/users/admin/:id", verifyJwt, verifyAdmin, async (req, res) => {
			// admin or not
            const decodedEmail = req.decoded.email;
            const query = {email : decodedEmail}
            const user = await usersCollection.findOne(query)
            if(user.role !== 'admin'){
                return res.status(403).send({message : 'forbidden access'})
            }

			const id = req.params.id;
			const filter = { _id: ObjectId(id) };
			const options = { upsert: true };
			const updatedDoc = {
				$set: {
					role: "admin",
				},
			};
			const result = await usersCollection.updateOne(
				filter,
				updatedDoc,
				options
			);
			res.send(result);
		});

		// // temporar to update price field on appointment options
		// app.get('/addprice', async(req,res) =>{
		//     const filter = {}
		//     const options = {upsert : true}
		//     const updateDoc = {
		//         $set : {
		//             price : 99
		//         }
		//     }
		//     const result = await appointmentOptionCollection.updateMany(filter, updateDoc, options)
		// })

		// doctor collection create
		app.post("/doctors", verifyJwt, verifyAdmin, async (req, res) => {
			const doctor = req.body;
			const result = await doctorsCollection.insertOne(doctor);
			res.send(result);
		});
		// load all doctors
		app.get("/doctors", verifyJwt, verifyAdmin, async (req, res) => {
			const query = {};
			const doctors = await doctorsCollection.find(query).toArray();
			res.send(doctors);
		});
		// delete doctor
		app.delete("/doctors/:id", verifyJwt, verifyAdmin, async (req, res) => {
			const id = req.params.id;
			const filter = { _id: ObjectId(id) };
			const result = await doctorsCollection.deleteOne(filter);
			res.send(result);
		});
	} finally {
	}
}
run().catch((err) => console.error(err));

app.get("/", async (req, res) => {
	res.send("doctors portal is running");
});

app.listen(port, () => console.log(`Doctors portal running is on ${port}`));
