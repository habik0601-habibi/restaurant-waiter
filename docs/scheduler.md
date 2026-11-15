# The kitchen scheduler

Code: [`src/lib/scheduler/scheduler.ts`](../src/lib/scheduler/scheduler.ts) (pure module, no imports).
Tests: [`scheduler.test.ts`](../src/lib/scheduler/scheduler.test.ts) (22 tests). Simulation: [`scripts/simulate.ts`](../scripts/simulate.ts).

## The problem

A table orders a karahi (22 minutes on the stove), two naan (4 minutes in the tandoor) and a lassi (3 minutes). A normal kitchen screen shows all four at once and the cooks start all four at once. The lassi is ready after 3 minutes and the naan after 4, then both sit for 18 minutes while the karahi cooks. The naan arrives cold.

The scheduler decides **when each dish should start** so that:

1. all dishes of one order finish close together,
2. no station cooks more dishes at once than its capacity,
3. an old order is never starved by newer ones.

It outputs a start time per dish (shown on the kitchen display) and a ready time per order (shown to the guest as a live waiting time). It runs again whenever an order arrives, a dish changes status, or a dish runs late.

This is a resource-constrained scheduling problem with a just-in-time objective. The general problem is NP-hard, so the module is a heuristic, not an exact solver.

## Model

- **Station**: an id and a capacity (parallel cooking slots).
- **Dish**: belongs to one order and one station, has an expected prep time, and is `queued`, `cooking` or `ready`.
- **Time**: minutes on one clock. The caller chooses the origin.
- Each station is a set of slots; each slot is a sorted list of busy intervals. Two operations are enough for everything below: *earliest* start at which a slot is free for a duration, and *latest* start that still ends by a deadline.

## Baseline: first come, first served (`planFcfs`)

Orders are taken oldest first. Every dish starts at the earliest moment its station has a free slot. This is what a kitchen without a scheduler does. It finishes each order as early as that ordering allows, but dishes of one order finish far apart.

## Optimised scheduler (`planOptimised`)

It builds a plan in four passes. This is forward-backward improvement, a technique from project scheduling.

| Pass | What it does |
|---|---|
| F1 forward | Exactly the baseline. Gives each order a completion time C. |
| B1 backward | Treats C as a deadline and moves every dish as **late** as its station allows. Short dishes now start late and land with the long ones. |
| F2 forward | Takes dishes in the order B1 starts them and pulls each as early as possible again. Capacity freed by B1 lets some orders finish sooner. Kept only if no order finishes later than in F1. |
| B2 backward | Moves dishes late again against the best completion times, this time with the safety buffer. |

Then an **improvement pass** tries swapping the priority of neighbouring orders and rebuilds the plan. A swap is kept only if it lowers the total cost (sum over orders of wait plus finish spread) and passes the starvation rule below.

### Guarantees (each has a test)

- **Capacity is never exceeded.** Checked on random kitchens by `assertFeasible`.
- **No order is planned later than under FCFS** when swaps are off. The backward pass only moves dishes later within a deadline that the forward pass already met. If a station cannot be packed that way, it keeps its forward placements.
- **No starvation.** With swaps on, no order may end more than `maxSlip` minutes (default 4) later than it would under strict oldest-first. That reference plan cannot be influenced by newer orders, so repeated re-planning cannot push an old order back again and again.
- **Cooking dishes are never moved.** They are fixed intervals.
- **Deterministic.** Same input, same plan.

### Re-planning

The scheduler is stateless. Each run takes the current kitchen and returns a full plan.

- A new order is simply a new input.
- A dish that is cooking past its expected end is assumed to need `overrun` more minutes (default 1). Its order's deadline moves back, and so does everything planned behind it on that station.
- If part of an order is already ready, the rest is finished as soon as possible.

### Options

| Option | Default | Meaning |
|---|---|---|
| `buffer` | 0.15 | A held dish is aimed to finish 15% of its own prep time before the deadline, as slack against prep-time noise. |
| `maxSlip` | 4 | Starvation bound in minutes. |
| `spreadWeight` | 1 | Weight of finish spread against wait in the cost. |
| `guardBusyStations` | false | Throughput mode, see below. |
| `improve` | true | Run the swap pass. |

## Simulation results

`npm run simulate` runs 20 simulated evenings of 180 minutes per scenario. Orders arrive at random (Poisson). Real prep times differ from the menu estimate by a lognormal factor (sigma 0.15), so dishes run early and late and the planner must re-plan, as in production. Both planners face the same orders and the same prep times. All numbers are minutes. Raw output: [`simulation-output.txt`](simulation-output.txt).

| Scenario | Planner | Avg wait | p95 wait | Avg finish spread | p95 spread | Avg dish sitting |
|---|---|---|---|---|---|---|
| Quiet (5 orders/h) | FCFS baseline | 24.0 | 40.6 | 21.2 | 38.6 | 14.7 |
| | **Optimised** | 25.7 | 41.8 | **6.2** | 15.5 | **3.0** |
| | Optimised, throughput mode | 24.6 | 41.6 | 16.2 | 36.3 | 9.0 |
| Normal (8 orders/h) | FCFS baseline | 31.0 | 52.3 | 28.0 | 50.3 | 18.5 |
| | **Optimised** | 34.3 | 56.6 | **7.6** | 18.2 | **3.5** |
| | Optimised, throughput mode | 31.4 | 54.0 | 23.8 | 47.9 | 13.6 |
| Rush (11 orders/h) | FCFS baseline | 47.4 | 86.9 | 43.8 | 84.1 | 26.5 |
| | **Optimised** | 52.2 | 92.2 | **9.5** | 22.5 | **4.2** |
| | Optimised, throughput mode | 46.4 | 88.6 | 38.1 | 79.7 | 20.5 |

- **Wait**: order placed until its last dish is ready.
- **Finish spread**: first dish ready until last dish ready.
- **Dish sitting**: how long a finished dish waits for the rest of its order.

### What the numbers say

- The optimised scheduler cuts finish spread by **71% to 78%** and dish sitting time by **80% to 84%**.
- It costs **7% to 11% more wait** (1.7 to 4.8 minutes). The plan itself is never later than FCFS; the loss appears in the simulation because a dish started at the last moment has no slack when its prep runs long, and because a slot left idle for a held dish is capacity a later, not-yet-known order could have used.
- **Throughput mode** removes that cost (wait within 2% of FCFS, slightly better in the rush) but keeps only 13% to 24% of the spread reduction. It never leaves a slot idle on a station where dishes are queuing.
- The default favours food arriving together. The trade-off is a setting, not a hidden assumption.
- Ablations in the raw output: without the buffer, wait is 1 to 2 minutes worse; without swaps, spread is 0.5 to 1.5 minutes worse.

## Limits

- **Heuristic.** It does not prove optimality and can miss better plans that need non-adjacent swaps.
- **Trusts prep times.** Estimates come from the menu. It does not learn real prep times per dish or per cook yet.
- **One station per dish, no steps.** A dish that needs the grill then the stove is modelled as one station.
- **No batching.** Four naan are four slots, although a tandoor might take them as one batch.
- **Cooks must follow the screen.** A cook can start a dish early; the next re-plan adapts, but the finish-together benefit for that order is lost.
- **Simulated, not measured.** The results come from a model kitchen with assumed order mixes and noise, not from a real restaurant.
- **Cost of the swap pass** grows with the square of open orders. Fine for one restaurant (tens of open orders), not tuned beyond that.
