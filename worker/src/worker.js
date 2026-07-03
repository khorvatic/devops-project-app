const { Pool } = require("pg");
const { createClient } = require("redis");
const http = require("http");
require("dotenv").config();

const queueName = process.env.QUEUE_NAME || "ticket_orders";
const healthPort = Number(process.env.WORKER_HEALTH_PORT || 9000);

const pgPool = new Pool({
    host: process.env.POSTGRES_HOST || "postgres",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "ticketing",
    user: process.env.POSTGRES_USER || "ticketing_user",
    password: process.env.POSTGRES_PASSWORD || "change_me_local"
});

const redisClient = createClient({
    socket: {
        host: process.env.REDIS_HOST || "redis",
        port: Number(process.env.REDIS_PORT || 6379)
    }
});

async function processOrder(rawPayload) {
    const order = JSON.parse(rawPayload);
    await pgPool.query(
        `INSERT INTO ticket_orders (order_id, event_id, customer_email, quantity, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id) DO NOTHING`,
        [order.orderId, order.eventId, order.customerEmail, order.quantity, "processed"]
    );
}

// --- Health check HTTP server ---
const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "worker" }));
        return;
    }

    if (req.url === "/readyz") {
        try {
            await pgPool.query("SELECT 1");
            await redisClient.ping();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ready" }));
        } catch (error) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "not-ready", error: error.message }));
        }
        return;
    }

    res.writeHead(404);
    res.end();
});

async function startWorker() {
    redisClient.on("error", (error) => {
        console.error("Redis error:", error.message);
    });

    await redisClient.connect();
    await pgPool.query("SELECT 1");

    healthServer.listen(healthPort, () => {
        console.log(`Worker health server listening on port ${healthPort}`);
    });

    console.log("Worker started and waiting for jobs...");

    while (true) {
        try {
            const result = await redisClient.brPop(queueName, 0);
            if (result?.element) {
                await processOrder(result.element);
                console.log("Order processed");
            }
        } catch (error) {
            console.error("Worker loop error:", error.message);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
}

startWorker().catch((error) => {
    console.error("Worker fatal error:", error);
    process.exit(1);
});

process.on("SIGTERM", async () => {
    healthServer.close();
    await pgPool.end();
    if (redisClient.isOpen) {
        await redisClient.quit();
    }
    process.exit(0);
});