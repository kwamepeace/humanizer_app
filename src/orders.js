const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Each order lives in <dataDir>/orders/<reference>/ with the uploaded file and
// a meta.json. Orders are also kept in memory for quick lookups.
function createOrderStore(dataDir) {
  const root = path.join(dataDir, 'orders');
  fs.mkdirSync(root, { recursive: true });
  const orders = new Map();

  for (const ref of fs.readdirSync(root)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, ref, 'meta.json'), 'utf8'));
      orders.set(meta.reference, meta);
    } catch {
      // Half-written order from a crash; the cleanup job will not see it, so drop it now.
      fs.rmSync(path.join(root, ref), { recursive: true, force: true });
    }
  }

  function dirFor(reference) {
    return path.join(root, reference);
  }

  function save(order) {
    orders.set(order.reference, order);
    const file = path.join(dirFor(order.reference), 'meta.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(order, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    return order;
  }

  return {
    newReference() {
      return `TH-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
    },

    create({ reference, customer, file, amountPesewas, currency }) {
      const dir = dirFor(reference);
      fs.mkdirSync(dir, { recursive: true });
      const storedName = `upload${path.extname(file.originalName).toLowerCase()}`;
      fs.writeFileSync(path.join(dir, storedName), file.buffer);
      return save({
        reference,
        customer,
        file: { originalName: file.originalName, storedName, size: file.buffer.length },
        amountPesewas,
        currency,
        status: 'pending', // pending -> paid -> delivered
        createdAt: new Date().toISOString(),
      });
    },

    get(reference) {
      return orders.get(reference);
    },

    all() {
      return [...orders.values()];
    },

    filePath(order) {
      return path.join(dirFor(order.reference), order.file.storedName);
    },

    update(reference, changes) {
      return save({ ...orders.get(reference), ...changes });
    },

    remove(reference) {
      orders.delete(reference);
      fs.rmSync(dirFor(reference), { recursive: true, force: true });
    },
  };
}

module.exports = { createOrderStore };
