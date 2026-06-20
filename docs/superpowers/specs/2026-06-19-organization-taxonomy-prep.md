# Organization Taxonomy Prep

## Recommended Shape

Add `Organization` as a first-class node type for companies, institutions,
clubs, agencies, nonprofits, schools, teams, collectives, formal groups, and
named informal groups such as recurring friend groups or communities. Do not
use it for a product, project, app, document, event, abstract movement, or
loose topic unless the product explicitly denotes the organization itself.

`Organization` should be extraction-mintable. Keeping it out of extraction
would preserve the current failure mode where companies are forced into
`Person`, `Concept`, or `Object`, which then corrupts predicates such as
`WORKS_AT`, `FOUNDED`, `AFFILIATED_WITH`, and `LOCATED_IN`.

Organizations should be label-mergeable by the existing exact-label automatic
merge rule. They are durable referents like people and locations, not occurrence
records.

## Predicate Shape Updates

Recommended relationship ranges:

- `WORKS_AT`: `Person -> Organization`.
- `FOUNDED`: `Person -> Organization | Concept | Object`.
- `CREATED`: `Person | Organization | Concept | Object -> Object | Concept | Media | Document | Task`.
- `LOCATED_IN`: include `Organization -> Location`.
- `OWNS`: include `Organization` as an owner and as an owned thing.
- `AFFILIATED_WITH`: include `Organization` on both sides.
- `USES`: include `Organization` as a subject.
- `RELATED_TO`: unchanged fallback.

`Organization` should not make `PARTICIPATED_IN` broader; participation remains
`Person -> Event | Conversation` unless we later model organization-level
participation deliberately.

## Prompt And Eval Updates

Extraction prompt should explicitly say:

- companies/employers/clients/schools/nonprofits/named informal groups are
  `Organization`;
- products/apps/projects are usually `Object` or `Concept`, not
  `Organization`, unless the text clearly refers to the organization operating
  them;
- do not create fake people for company names.

Eval coverage should include:

- a person works at an organization;
- a person founded an organization;
- an organization is located in a city;
- an organization created/uses a product;
- a product/project remains `Object`/`Concept`, not `Organization`.

## Migration Prep

Historical retyping should run automatically and invisibly for high-confidence
cases across all users. Good candidate signals:

- a node appears as the object of `WORKS_AT`, `FOUNDED`, or
  `AFFILIATED_WITH`;
- a node has labels with organization suffixes such as "Inc", "LLC", "Ltd",
  "GmbH", "BV", "University", "Foundation", "Agency", "Studio", or "Bank";
- a node description explicitly says company, employer, client, organization,
  institution, nonprofit, school, or team.

Avoid automatic retyping from label alone in the first migration. A term like
"Bank", "Studio", or a product name can be an object, concept, project, or
organization depending on context.

## Product Decisions

1. `Organization` includes informal recurring named groups, not only formal
   legal entities.
2. `Organization OWNS Organization` is allowed.
3. Historical retyping is automatic and invisible for high-confidence cases;
   there is no user review UI for these repairs.
