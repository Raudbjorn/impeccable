export default [
  { id: 'compose-help', verb: 'compose', args: ['--help'], workspace: 'ctx-empty' },
  { id: 'compose-invalid-grammar', verb: 'compose', args: ['validate'], workspace: 'ctx-empty', stdin: JSON.stringify({ draft: { entries: [{ id: 'invalid', kind: 'composition', familyId: 'reading', surface: 'read', form: 'Reading', spark: 'Read', webLeverage: 'Anchors', grammar: ['wrong order'] }] } }) },
];
