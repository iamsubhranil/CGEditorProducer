// Access the callback-based API
var amqp = require("amqplib/callback_api");
// THIS SHOULD BE A SECRET
const CLOUDAMQP_URL = process.env.AMQP_URL;

var senderChannel = null;
var queue_map = {};

const OPERATION_CREATE = "create";
const OPERATION_SEND = "send";
const OPERATION_JOIN = "join";

const ERR_QUEUE_NAME_NOT_SPECIFIED = 460;
const ERR_START = ERR_QUEUE_NAME_NOT_SPECIFIED;
const ERR_OPERATION_NAME_NOT_SPECIFIED = 461;
const ERR_RESERVED_QUEUE_NAME = 462;
const ERR_QUEUE_IN_USE = 463;
const ERR_QUEUE_NOT_FOUND = 464;
const ERR_INVALID_OPERATION = 465;

const ERROR_MESSAGES = [
	"Queue name not specified in request!",
	"Operation name not specified in request!",
	"Specified queue name is reserved!",
	"Queue already in use!",
	"Queue not found!",
	"Invalid operation!",
];

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
if(PORT == null || PORT == "") {
    PORT = 8081;
}

var http = require("http");
var server = http.createServer(function (req, res) {
	res.setHeader("Access-Control-Allow-Origin", "*");
	var data = "";
	req.on("data", function (chunk) {
		data = JSON.parse(chunk);
		// check if queue_name exists in request
		if (!("queue_name" in data)) {
			writeResponse(res, ERR_QUEUE_NAME_NOT_SPECIFIED);
			return;
		}
		// check if operation exists in request
		if (!("operation" in data)) {
			writeResponse(res, ERR_OPERATION_NAME_NOT_SPECIFIED);
			return;
		}
		var q = data["queue_name"];
		var op = data["operation"];
		if (q == COMMAND_QUEUE) {
			writeResponse(res, ERR_RESERVED_QUEUE_NAME);
			return;
		}
		if (op == OPERATION_CREATE) {
			// if this is a handshake, check if the queue can be allocated
			if (q in queue_map) {
				writeResponse(res, ERR_QUEUE_IN_USE);
			} else {
				queue_map[q] = new Date();
				senderChannel.assertQueue(q, { durable: false });
				// send a command to a server to add a listener for this queue
				senderChannel.sendToQueue(
					COMMAND_QUEUE,
					Buffer.from("add " + q)
				);
				writeResponse(res, 200, "Queue generated!");
			}
		} else if (op == OPERATION_SEND) {
			// this is a send, so send to the specified queue, and
			// regenerate its timestamp
			if (!(q in queue_map)) {
				// check if the queue exists
				writeResponse(res, ERR_QUEUE_NOT_FOUND);
				return;
			}
			senderChannel.sendToQueue(q, Buffer.from(chunk));
			queue_map[q] = new Date();
			writeResponse(res, 200, "Message sent!");
		} else if (op == OPERATION_JOIN) {
			if (!(q in queue_map)) {
				writeResponse(res, ERR_QUEUE_NOT_FOUND);
				return;
			}
			// the queue is accessed recently
			queue_map[q] = new Date();
			writeResponse(res, 200, "Added to the session!");
		} else {
			writeResponse(res, ERR_INVALID_OPERATION);
		}
	});
	req.on("end", function () {
		console.log("Request received from: " + req.socket.remoteAddress);
		console.log("Request Message :", data);
		//console.log("Message:   Received " + data.insertedText + " at " + data.startLoc);
	});
});

server.maxConnections = 20;

amqp.connect(CLOUDAMQP_URL, function (error0, connection) {
	if (error0) {
		throw error0;
	}
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

const INACTIVE_TIMEOUT_MILLS = 1000 * 60 * 1;

function purgeQueue() {
	console.log("[x] Cleanup started..");
	var d = new Date();
	for (var q in queue_map) {
		if (d - queue_map[q] >= INACTIVE_TIMEOUT_MILLS) {
			// purge this
			console.log("[x] Requesting to delete '" + q + "'..");
			senderChannel.sendToQueue(
				COMMAND_QUEUE,
				Buffer.from("remove " + q)
			);
			delete queue_map[q];
		}
	}
	console.log("[x] Cleanup finished..");
}

// wake up every 5 minutes to purge any unused queue
setInterval(purgeQueue, INACTIVE_TIMEOUT_MILLS);
