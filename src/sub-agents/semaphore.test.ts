import { describe, it, expect } from "vitest";
import { Semaphore } from "./semaphore";

describe("Semaphore", () => {
	it("acquires up to cap immediately", async () => {
		const sem = new Semaphore(3);
		await sem.acquire();
		await sem.acquire();
		await sem.acquire();
		expect(sem.active).toBe(3);
		expect(sem.pending).toBe(0);
		sem.release();
		sem.release();
		sem.release();
	});

	it("blocks when acquiring beyond cap", async () => {
		const sem = new Semaphore(2);
		await sem.acquire();
		await sem.acquire();

		let thirdAcquired = false;
		const thirdPromise = sem.acquire().then(() => {
			thirdAcquired = true;
		});

		// Allow microtasks to flush
		await Promise.resolve();
		expect(thirdAcquired).toBe(false);
		expect(sem.pending).toBe(1);
		expect(sem.active).toBe(2);

		// Release one → third should acquire
		sem.release();
		await thirdPromise;
		expect(thirdAcquired).toBe(true);
		expect(sem.active).toBe(2);
		expect(sem.pending).toBe(0);

		sem.release();
		sem.release();
	});

	it("4th concurrent acquire waits until one of first 3 releases", async () => {
		const sem = new Semaphore(3);
		const order: number[] = [];

		await sem.acquire(); // slot 1
		await sem.acquire(); // slot 2
		await sem.acquire(); // slot 3

		const fourthPromise = sem.acquire().then(() => {
			order.push(4);
		});

		// Fourth should be waiting
		await Promise.resolve();
		expect(sem.pending).toBe(1);
		expect(order).toEqual([]);

		// Release one slot
		sem.release();
		await fourthPromise;
		expect(order).toEqual([4]);
		expect(sem.active).toBe(3);

		sem.release();
		sem.release();
		sem.release();
	});

	it("releases waiters in FIFO order", async () => {
		const sem = new Semaphore(1);
		await sem.acquire();

		const order: string[] = [];

		const p1 = sem.acquire().then(() => order.push("first"));
		const p2 = sem.acquire().then(() => order.push("second"));
		const p3 = sem.acquire().then(() => order.push("third"));

		expect(sem.pending).toBe(3);

		sem.release(); // unblocks first
		await p1;
		sem.release(); // unblocks second
		await p2;
		sem.release(); // unblocks third
		await p3;

		expect(order).toEqual(["first", "second", "third"]);
		sem.release();
	});

	it("reports active and pending counts correctly", async () => {
		const sem = new Semaphore(2);
		expect(sem.active).toBe(0);
		expect(sem.pending).toBe(0);

		await sem.acquire();
		expect(sem.active).toBe(1);
		expect(sem.pending).toBe(0);

		await sem.acquire();
		expect(sem.active).toBe(2);
		expect(sem.pending).toBe(0);

		const waiter = sem.acquire(); // will block
		await Promise.resolve();
		expect(sem.active).toBe(2);
		expect(sem.pending).toBe(1);

		sem.release();
		await waiter;
		expect(sem.active).toBe(2);
		expect(sem.pending).toBe(0);

		sem.release();
		sem.release();
		expect(sem.active).toBe(0);
	});
});
