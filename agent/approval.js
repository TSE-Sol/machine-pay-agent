// Human approval in the terminal (later the dashboard can do this).
import { createInterface } from "node:readline/promises";

/**
 * Ask a y/n question. Only an explicit "y" or "yes" approves.
 * With no interactive terminal there is nobody to ask, so the answer is no.
 */
export async function askInTerminal(question) {
  if (!process.stdin.isTTY) {
    console.log(`${question} -> no interactive terminal, treating as "no"`);
    return false;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}
