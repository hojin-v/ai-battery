import fs from "node:fs";

export function createIntegrationFiles({ readConfig, writeConfig, writeTextAtomic }) {
  const key = file => file;
  const recordFor = file => readConfig({ strict: true }).integrationFiles?.[key(file)];
  const read = file => {
    try { return fs.readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  function checkTarget(file, record) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if ((record?.target && fs.realpathSync(file) !== record.target) || (!record?.target && stat.isSymbolicLink())) {
      throw new Error(`Integration symlink target changed; left untouched: ${file}`);
    }
  }
  function stripRecorded(text, record, file) {
    if (text === record.beforeText) return text;
    const index = text.indexOf(record.block);
    if (index < 0) throw new Error(`AI Battery integration block was edited; kept the file and recovery record: ${file}`);
    const before = text.slice(0, index);
    const after = text.slice(index + record.block.length);
    const separator = before && after && !before.endsWith("\n") && !after.startsWith("\n") ? "\n" : "";
    return before + separator + after;
  }
  function stripOwnedBlock(file, text, fallback) {
    const record = recordFor(file);
    if (!record) return fallback(text);
    checkTarget(file, record);
    return stripRecorded(text, record, file);
  }
  function installManagedText(file, next, block) {
    const config = readConfig({ strict: true });
    const previous = config.integrationFiles?.[key(file)];
    if (previous) checkTarget(file, previous);
    const current = read(file);
    if (previous && current !== null) {
      checkTarget(file, previous);
      stripRecorded(current, previous, file);
    }
    if (!block) throw new Error(`Cannot record an empty integration block: ${file}`);
    const mode = current === null ? 0o600 : fs.statSync(file).mode & 0o777;
    const record = {
      beforeText: previous && current !== null
        ? current === previous.installedText ? previous.beforeText : stripRecorded(current, previous, file)
        : current,
      target: previous?.target || (current === null ? null : fs.realpathSync(file)),
      installedText: next,
      block
    };
    config.integrationFiles = { ...config.integrationFiles, [key(file)]: record };
    writeConfig(config);
    writeTextAtomic(file, next, mode);
  }
  function removeManagedText(file, fallback) {
    const config = readConfig({ strict: true });
    const record = config.integrationFiles?.[key(file)];
    if (record) checkTarget(file, record);
    const current = read(file);
    if (current === null) {
      if (record) { delete config.integrationFiles[key(file)]; writeConfig(config); }
      return false;
    }
    const next = record
      ? current === record.installedText ? record.beforeText : stripRecorded(current, record, file)
      : fallback(current);
    const changed = next !== current;
    if (changed) {
      if (next === null) fs.unlinkSync(file);
      else writeTextAtomic(file, next, fs.statSync(file).mode & 0o777);
    }
    if (record) { delete config.integrationFiles[key(file)]; writeConfig(config); }
    return changed;
  }
  return { installManagedText, removeManagedText, stripOwnedBlock };
}
