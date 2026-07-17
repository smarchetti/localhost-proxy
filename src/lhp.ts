#!/usr/bin/env node
import { main } from './cli';

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`lhp: ${err.message}`);
  process.exit(1);
});
