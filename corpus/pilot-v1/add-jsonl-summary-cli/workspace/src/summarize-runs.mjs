#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const inputPath = process.argv[2];
const input = await readFile(inputPath, 'utf8');
const total = input.split('\n').filter((line) => line.trim() !== '').length;

process.stdout.write(`${JSON.stringify({ total })}\n`);
