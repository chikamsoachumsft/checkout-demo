# Checkout (fictional sample)

The Commerce team's Checkout service: payment retries, idempotency keys and gateway webhooks.
Used to demo **AgentReturn** — tying AI agent work and cost to the project it was for, with shared
project memory across every person and agent.

> Fictional company, people, numbers and code — for demonstration only.

## Join the project (macOS or Windows)
You need **Node.js 18+** and **git**.

```
git clone https://github.com/chikamsoachumsft/checkout-demo
cd checkout-demo
npm install
npm run join        # name, email, invite code
```

Then open the folder in **Claude Code**, **Cursor** or **GitHub Copilot**. Your first session shows the
project welcome; tag your first prompt with a ticket and work type, e.g. `#1a add idempotency keys to refunds`.

Useful commands: `npm run page` (readable project memory in your browser), `npm run brief`,
`npm run project`, `npm run feed`.

## Run it
```
npm test
npm start   # http://localhost:5060
```
