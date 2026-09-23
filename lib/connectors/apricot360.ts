/**
 * The Bonterra Apricot 360 adapter shape.
 *
 * Field ids 101-128 and their `reference_tag` values are copied from
 * `connector-service/mock-server.mjs` so this service is wire-compatible with
 * the mock the extension was developed against. `reference_tag` is what the
 * extension maps onto a form field purpose, and it is also our canonical fact
 * key — that alignment is why no translation layer is needed.
 *
 * Bonterra's API is OAuth2 and available only to Apricot Enterprise and Pro
 * customers, so the live path needs an organization's own grant. Until one is
 * authorized, `mode: 'local-demo'` renders the seeded case graph back out in
 * Apricot's wire shape. That is a narrow thing to do, but it means the endpoint
 * contract is exercised end to end without holding anyone's credentials.
 */

export type ApricotSchemaField = {
  id: number;
  label: string;
  type: string;
  reference_tag: string;
};

export const APRICOT_DEMO_SOURCE_ID = '99';

export const APRICOT_DEMO_SCHEMA: ApricotSchemaField[] = [
  { id: 101, label: 'First Name', type: 'text', reference_tag: 'firstName' },
  { id: 102, label: 'Middle Name', type: 'text', reference_tag: 'middleName' },
  { id: 103, label: 'Last Name', type: 'text', reference_tag: 'lastName' },
  { id: 104, label: 'Date of Birth', type: 'date', reference_tag: 'dateOfBirth' },
  { id: 105, label: 'Primary Email', type: 'email', reference_tag: 'email' },
  { id: 106, label: 'Cell Phone', type: 'phone', reference_tag: 'phone' },
  { id: 107, label: 'Residential Address', type: 'text', reference_tag: 'addressLine1' },
  { id: 108, label: 'Apartment or Unit', type: 'text', reference_tag: 'addressLine2' },
  { id: 109, label: 'Residential City', type: 'text', reference_tag: 'city' },
  { id: 110, label: 'Residential State', type: 'text', reference_tag: 'state' },
  { id: 111, label: 'Residential County', type: 'text', reference_tag: 'county' },
  { id: 112, label: 'ZIP Code', type: 'text', reference_tag: 'postalCode' },
  { id: 113, label: 'Preferred Language', type: 'select', reference_tag: 'primaryLanguage' },
  { id: 114, label: 'Gender', type: 'select', reference_tag: 'gender' },
  { id: 115, label: 'Ethnicity', type: 'select', reference_tag: 'ethnicity' },
  { id: 116, label: 'Marital Status', type: 'select', reference_tag: 'maritalStatus' },
  { id: 117, label: 'Special Needs', type: 'boolean', reference_tag: 'specialNeeds' },
  { id: 118, label: 'Farm Worker', type: 'boolean', reference_tag: 'farmWorker' },
  { id: 119, label: 'Preferred Contact Method', type: 'select', reference_tag: 'preferredContact' },
  { id: 120, label: 'Housing Status', type: 'select', reference_tag: 'housingStatus' },
  { id: 121, label: 'Household Size', type: 'number', reference_tag: 'householdSize' },
  { id: 122, label: 'Citizenship Status', type: 'select', reference_tag: 'immigrationStatus' },
  { id: 123, label: 'Monthly Household Income', type: 'currency', reference_tag: 'income' },
  { id: 124, label: 'Pays for Childcare', type: 'boolean', reference_tag: 'childcare' },
  {
    id: 125,
    label: 'Receives Unemployment Benefits',
    type: 'boolean',
    reference_tag: 'unemployment',
  },
  { id: 126, label: 'Pregnancy Status', type: 'boolean', reference_tag: 'pregnant' },
  { id: 127, label: 'Social Security Number', type: 'sensitive', reference_tag: 'ssn' },
  { id: 128, label: 'Residential Country', type: 'text', reference_tag: 'country' },
];

const TAG_TO_FIELD_ID = new Map(
  APRICOT_DEMO_SCHEMA.map((field) => [field.reference_tag, field.id]),
);

export type ApricotRecord = {
  data: {
    id: number;
    type: 'records';
    attributes: Record<string, unknown>;
  }[];
};

/**
 * Renders canonical facts into Apricot's `field_<id>` attribute shape.
 *
 * Keys with no schema entry are dropped rather than invented, because the
 * extension validates mappings against the schema it fetched and an unknown
 * `field_*` key would be silently ignored anyway.
 */
export function toApricotRecord(
  recordId: string,
  facts: Record<string, unknown>,
  modifiedAt: Date,
): ApricotRecord {
  const attributes: Record<string, unknown> = {
    form_id: Number(APRICOT_DEMO_SOURCE_ID),
    mod_time: modifiedAt.toISOString(),
  };

  for (const [key, value] of Object.entries(facts)) {
    const fieldId = TAG_TO_FIELD_ID.get(key);
    if (fieldId === undefined) continue;
    attributes[`field_${fieldId}`] = value;
  }

  return {
    data: [{ id: Number(recordId), type: 'records', attributes }],
  };
}
