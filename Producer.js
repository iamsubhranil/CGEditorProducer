// Access the callback-based API
var amqp = require("amqplib/callback_api");
// THIS SHOULD BE A SECRET
const CLOUDAMQP_URL = process.env.AMQPURL;
if (CLOUDAMQP_URL == null || CLOUDAMQP_URL.length == 0) {
	console.log("[!] Error: Set AMQPURL environment variable first!");
}

var senderChannel = null;
var sending_queue_map = {};
var receiving_queue_list = [];
var pendingChanges = {};

const OPERATION_CREATE = "create";
const OPERATION_SEND = "send";
const OPERATION_JOIN = "join";
const OPERATION_RECEIVE = "receive";

const ERR_QUEUE_NAME_NOT_SPECIFIED = 460;
const ERR_START = ERR_QUEUE_NAME_NOT_SPECIFIED;
const ERR_OPERATION_NAME_NOT_SPECIFIED = 461;
const ERR_RESERVED_QUEUE_NAME = 462;
const ERR_QUEUE_IN_USE = 463;
const ERR_QUEUE_NOT_FOUND = 464;
const ERR_INVALID_OPERATION = 465;
const ERR_NO_NEW_OPERATION = 466;

const ERROR_MESSAGES = [
	"Queue name not specified in request!",
	"Operation name not specified in request!",
	"Specified queue name is reserved!",
	"Queue already in use!",
	"Queue not found!",
	"Invalid operation!",
	"No new update operation is present!",
];

/**
 * Writes a proper response to client's HTTP request
 * @param {object} res The HTTP response in which response is to be written
 * @param {number} code The status code
 * @param {string} msg The message to write
 */
function writeResponse(res, code, msg = "") {
	res.writeHead(code, { "Content-Type": "text/plain" });
	if (msg.length > 0) {
		res.write(msg);
	} else {
		res.write(ERROR_MESSAGES[code - ERR_START]);
	}
	res.end();
}

// the editor server will parse messages from this queue
// as commands, which will primary be used to add a new
// consumer to a queue, or remove a consumer from an
// existing queue
const COMMAND_QUEUE = "__cge_internal_command_queue";

var PORT = process.env.PORT;
if (PORT == null || PORT == "") {
	console.log("[!] Set PORT environment variable first!");
}

var transformedOperation = "";
var http = require("http");
var server = http.createServer(function (req, res) {
	res.setHeader("Access-Control-Allow-Origin", "*");
	var data = "";
	req.on("data", function (chunk) {
		data += chunk;
	});
	req.on("end", function () {
		data = JSON.parse(data);
		console.log("Request received from: " + req.socket.remoteAddress);
		console.log("Request Message :", data);
		// check if queue_name exists in request
		if (
			!("sending_queue_name" in data) ||
			!("receiving_queue_name" in data)
		) {
			writeResponse(res, ERR_QUEUE_NAME_NOT_SPECIFIED);
			return;
		}
		// check if operation exists in request
		if (!("operation" in data)) {
			writeResponse(res, ERR_OPERATION_NAME_NOT_SPECIFIED);
			return;
		}
		var sending_queue = data["sending_queue_name"];
		var receiving_queue = data["receiving_queue_name"];
		var op = data["operation"];
		if (
			sending_queue == COMMAND_QUEUE ||
			receiving_queue == COMMAND_QUEUE
		) {
			writeResponse(res, ERR_RESERVED_QUEUE_NAME);
			return;
		}
		if (op == OPERATION_CREATE) {
			// if this is a handshake, check if the queue can be allocated

			if (
				sending_queue in sending_queue_map ||
				sending_queue in receiving_queue_list ||
				receiving_queue in receiving_queue_list ||
				receiving_queue in sending_queue_map
			) {
				writeResponse(res, ERR_QUEUE_IN_USE);
			} else {
				sending_queue_map[sending_queue] = {
					lastAccessed: new Date(),
					receivingQueue: receiving_queue,
				};
				receiving_queue_list.push(receiving_queue);
				senderChannel.assertQueue(sending_queue, { durable: false });
				senderChannel.assertQueue(receiving_queue, { durable: false });
				pendingChanges[sending_queue] = [];
				senderChannel.consume(
					receiving_queue,
					function (msg) {
						if (msg == null) {
							console.log(
								"[x] Receiving queue '" +
									receiving_queue +
									"' removed!"
							);
						} else {
							console.log(
								"[+] Received in " +
									receiving_queue +
									" ---> " +
									msg.content.toString()
							);
							pendingChanges[sending_queue].push(
								// JSON.parse
								msg.content.toString()
							);
						}
					},
					{ noAck: true }
				);
				// send a command to a server to add a listener for these queues
				senderChannel.sendToQueue(
					COMMAND_QUEUE,
					Buffer.from("add " + sending_queue + " " + receiving_queue)
				);
				/*senderChannel.consume(
					receiving_queue,
					function (msg) {
						console.log(msg);
					},
					{ noAck: true });*/
				// wake up the server if it is sleeping
				wakeUpServer();
				// write the response back
				writeResponse(
					res,
					200,
					sending_queue_map[sending_queue].receivingQueue
				);
			}
		} else if (op == OPERATION_SEND) {
			// this is a send, so send to the specified queue, and
			// regenerate its timestamp
			if (!(sending_queue in sending_queue_map)) {
				// check if the queue exists
				writeResponse(res, ERR_QUEUE_NOT_FOUND);
				return;
			}
			// wake up the server if it is sleeping
			wakeUpServer();
			// send the change to queue
			senderChannel.sendToQueue(
				sending_queue,
				Buffer.from(JSON.stringify(data))
			);
			sending_queue_map[sending_queue].lastAccessed = new Date();
			writeResponse(res, 200, "Message sent!");
			//writeResponse(res, 200, transformedOperation);
			transformedOperation = "";
		} else if (op == OPERATION_JOIN) {
			if (!(sending_queue in sending_queue_map)) {
				writeResponse(res, ERR_QUEUE_NOT_FOUND);
				return;
			}
			// these queues are accessed recently
			sending_queue_map[sending_queue].lastAccessed = new Date();
			writeResponse(
				res,
				200,
				sending_queue_map[sending_queue].receivingQueue
			);
		} else if (op == OPERATION_RECEIVE) {
			if (!(sending_queue in sending_queue_map)) {
				writeResponse(res, ERR_QUEUE_NOT_FOUND);
				return;
			}
			// Add code to send messages to collaborative_js
			var receiveFrom = data["receiveFrom"];
			if (pendingChanges[sending_queue].length <= receiveFrom) {
				writeResponse(res, ERR_NO_NEW_OPERATION);
			} else {
				var changes = [];
				for (
					var i = receiveFrom;
					i < pendingChanges[sending_queue].length;
					i++
				) {
					changes.push(pendingChanges[sending_queue][i]);
				}
				var toSend = {
					numOfChanges: pendingChanges[sending_queue].length - i + 1,
					changesToUpdate: changes,
				};
				writeResponse(res, 200, JSON.stringify(toSend));
			}
		} else {
			writeResponse(res, ERR_INVALID_OPERATION);
		}
	});
});

server.maxConnections = 20;

amqp.connect(CLOUDAMQP_URL, function (error0, connection) {
	if (error0) {
		throw error0;
	}
	// Sending Queue
	connection.createChannel(function (error1, channel) {
		if (error1) {
			throw error1;
		}
		console.log("[x] Connected to rabbitmq instance!");
		channel.assertQueue(COMMAND_QUEUE, { durable: false });
		console.log("[x] Connected to the command queue!");
		senderChannel = channel;
		console.log("[x] Starting server..");
		server.listen(PORT);
	});
	// Receiving Queue
});

/*
const localtunnel = require("localtunnel");
const PREFERRED_SUBDOMAIN = "cgeproducerserver";
(async () => {
	const tunnel = await localtunnel({
		port: PORT,
		subdomain: PREFERRED_SUBDOMAIN,
	});

	// the assigned public url for your tunnel
	// i.e. https://abcdefgjhij.localtunnel.me
	console.log("Connect to: " + tunnel.url);

	tunnel.on("close", () => {
		// tunnels are closed
	});
})();*/

const INACTIVE_TIMEOUT_MILLS = 1000 * 60 * 10;

/**
 * Removes the communication queues that have been idle for too long
 */
function purgeQueue() {
	console.log("[x] Cleanup started..");
	var d = new Date();
	for (var q in sending_queue_map) {
		if (d - sending_queue_map[q].lastAccessed >= INACTIVE_TIMEOUT_MILLS) {
			// purge this
			console.log("[x] Requesting to delete '" + q + "'..");
			senderChannel.sendToQueue(
				COMMAND_QUEUE,
				Buffer.from(
					"remove " + q + " " + sending_queue_map[q].receivingQueue
				)
			);
			delete sending_queue_map[q];
			delete pendingChanges[q];
		}
	}
	console.log("[x] Cleanup finished..");
}

const SERVER_URL = process.env.SERVERURL;
if (SERVER_URL == null || SERVER_URL.length == 0) {
	console.log("[!] Error: Set SERVERURL environment variable first!");
}

/**
 * Pings the server to wake it up and handle messages
 */
function wakeUpServer() {
	var h = require("http");
	h.get(SERVER_URL);
}

// wake up every 5 minutes to purge any unused queue
setInterval(purgeQueue, INACTIVE_TIMEOUT_MILLS);
