jest.mock("pg", () => {
    return {
        Pool: jest.fn().mockImplementation(() => ({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            end: jest.fn(),
            on: jest.fn()
        }))
    };
});

jest.mock("redis", () => {
    return {
        createClient: jest.fn().mockImplementation(() => ({
            isOpen: false,
            connect: jest.fn().mockResolvedValue(undefined),
            ping: jest.fn().mockResolvedValue("PONG"),
            lPush: jest.fn().mockResolvedValue(1),
            quit: jest.fn(),
            on: jest.fn()
        }))
    };
});

const request = require("supertest");
const { app } = require("../src/app");

describe("GET /healthz", () => {
    it("vraća status 200 i service: api", async () => {
        const response = await request(app).get("/healthz");

        expect(response.status).toBe(200);
        expect(response.body.status).toBe("ok");
        expect(response.body.service).toBe("api");
    });
});

describe("GET /events", () => {
    it("vraća listu od 3 eventa", async () => {
        const response = await request(app).get("/events");

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(3);
        expect(response.body[0]).toHaveProperty("id");
        expect(response.body[0]).toHaveProperty("name");
    });
});

describe("POST /tickets/purchase", () => {
    it("vraća 400 kad nedostaje eventId", async () => {
        const response = await request(app)
            .post("/tickets/purchase")
            .send({ customerEmail: "student@example.com", quantity: 2 });

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/eventId/);
    });

    it("vraća 404 kad event ne postoji", async () => {
        const response = await request(app)
            .post("/tickets/purchase")
            .send({ eventId: "evt-9999", customerEmail: "student@example.com", quantity: 2 });

        expect(response.status).toBe(404);
    });

    it("vraća 400 kad je quantity nevažeći (0 ili negativan)", async () => {
        const response = await request(app)
            .post("/tickets/purchase")
            .send({ eventId: "evt-1001", customerEmail: "student@example.com", quantity: 0 });

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/quantity/);
    });

    it("vraća 202 i orderId kad je zahtjev valjan", async () => {
        const response = await request(app)
            .post("/tickets/purchase")
            .send({ eventId: "evt-1001", customerEmail: "student@example.com", quantity: 2 });

        expect(response.status).toBe(202);
        expect(response.body).toHaveProperty("orderId");
        expect(response.body.message).toBe("Order queued");
    });
});