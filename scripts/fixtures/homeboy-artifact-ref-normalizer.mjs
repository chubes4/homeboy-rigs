#!/usr/bin/env node

const ref = process.argv.at(-1) || '';

if (ref === '<artifact-ref>') {
  console.error('must be a reviewer-facing artifact ref');
  process.exit(1);
}

if (ref === 'artifact:./report.json' || ref.startsWith('homeboy-artifact:///tmp/')) {
  console.error('must not use local evidence');
  process.exit(1);
}

if (!ref.startsWith('homeboy://run/') && !ref.startsWith('homeboy-runs:')) {
  console.error('must be a reviewer-facing artifact ref');
  process.exit(1);
}

process.stdout.write(`${ref}\n`);
