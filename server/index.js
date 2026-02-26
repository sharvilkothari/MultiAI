import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(join(__dirname, '..', 'client')));

app.listen(PORT, () => {
  console.log(`AI Compare server at http://localhost:${PORT}`);
});
