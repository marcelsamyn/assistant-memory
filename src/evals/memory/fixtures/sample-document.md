# Episode 142: Scaling Orchard — How Maya Restructured the Pricing Team

_This is a fictional sample document used by `pnpm run eval:ingest` to exercise the
extraction pipeline. It is intentionally dense with concrete, checkable facts._

In this episode, host Daniel Okafor interviews Maya Lindqvist, VP of Product at
Orchard Labs, a Stockholm-based company that builds inventory software for
independent grocers. Orchard was founded in 2019 by Maya and her co-founder
Theo Park, who currently serves as CTO.

Maya explains that Orchard hit €4.2M in annual recurring revenue at the end of
2024, up from €1.8M the previous year. The company employs 38 people, with 12 of
them on the engineering team. Their flagship product, ShelfSense, is used by
roughly 600 grocery stores across the Nordics.

The core of the conversation is a pricing overhaul Maya led in Q1 2025. Until
then, Orchard charged a flat €99 per store per month. Maya decided to move to a
three-tier model: a Starter tier at €49, a Growth tier at €129, and an
Enterprise tier priced custom. She says the flat fee was leaving money on the
table for large multi-store chains while pricing out single-shop owners.

Maya is explicit that the decision was driven by churn data: stores with a single
location were churning at 4% per month, nearly double the 2.2% blended rate. The
new Starter tier was designed specifically to retain those small operators.

To run the migration, Maya hired a pricing analyst named Priya Raman in January 2025. Priya previously worked at Klarna. Maya recommends that any founder doing a
repricing should grandfather existing customers for at least six months — Orchard
gave its existing base twelve months at their old rate, which Maya now thinks was
too generous.

Theo pushed back on the Enterprise tier initially, arguing it would slow down the
sales cycle. They compromised by capping custom quotes at a 2-week turnaround.
Maya admits Theo was partly right: the average Enterprise deal now takes 47 days
to close, versus 9 days for self-serve tiers.

On tooling, Orchard switched its billing from Stripe Billing to a custom system
built on top of the Stripe API, because Stripe Billing could not handle their
usage-based Enterprise contracts. Maya does not recommend this for most
companies — she calls it "a six-month tax we paid for flexibility we barely use."

Maya's three takeaways: first, instrument churn by segment before you reprice.
Second, give yourself a single owner for the migration — Priya was that person.
Third, communicate price changes at least 60 days ahead; Orchard gave 30 days and
got a spike in support tickets.

The episode closes with Maya mentioning that Orchard is raising a Series B,
targeting €15M, led by a firm she would not name. She expects to close it by
September 2025.
