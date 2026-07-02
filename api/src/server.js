const { app, pgPool, redisClient, connectRedis } = require("./app");

const port = Number(process.env.API_PORT || 8080);

connectRedis()
    .then(() => {
        app.listen(port, () => {
            console.log(`API listening on port ${port}`);
        });
    })
    .catch((error) => {
        console.error("Failed to start API:", error);
        process.exit(1);
    });

process.on("SIGTERM", async () => {
    await pgPool.end();
    if (redisClient.isOpen) {
        await redisClient.quit();
    }
    process.exit(0);
});