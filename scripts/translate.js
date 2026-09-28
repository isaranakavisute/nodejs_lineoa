// Try a translation from the command line without going through LINE.
// Usage: npm run translate -- "<text>" [targetLanguage]
import { config } from '../src/config.js';
import { translate } from '../src/translate.js';

const [text, target] = process.argv.slice(2);

if (!text) {
  console.error('Usage: npm run translate -- "<text>" [targetLanguage]');
  process.exit(1);
}

const started = Date.now();
const result = await translate(text, {
  target: target || config.translation.defaultTarget,
  secondary: config.translation.defaultSecondary,
});
console.log(result);
console.error(`(${config.anthropic.model}, ${Date.now() - started} ms)`);
