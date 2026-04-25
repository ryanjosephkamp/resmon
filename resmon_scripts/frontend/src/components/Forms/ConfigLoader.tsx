import React, { useEffect, useState } from 'react';
import { apiClient } from '../../api/client';
import { useConfigurationsVersion } from '../../lib/configurationsBus';

export interface SavedConfig {
  id: number;
  name: string;
  config_type: string;
  parameters: Record<string, any> | string;
}

interface Props {
  /** One of: ``manual_dive``, ``manual_sweep``, ``routine``. */
  configType: 'manual_dive' | 'manual_sweep' | 'routine';
  /** Called with the parsed parameters blob when the user picks a config. */
  onLoad: (parameters: Record<string, any>, config: SavedConfig) => void;
  /** Bump to trigger a refetch (e.g., after a save). */
  refreshKey?: number | string;
  label?: string;
}

const ConfigLoader: React.FC<Props> = ({ configType, onLoad, refreshKey, label }) => {
  const [configs, setConfigs] = useState<SavedConfig[]>([]);
  const [value, setValue] = useState('');
  // Subscribe to the global configurations-changed bus so that any mutation
  // anywhere in the app (delete on the Configurations page, save on a sibling
  // page, import) forces every mounted loader to refetch — closing the gap
  // where a deleted config could otherwise linger in this dropdown.
  const configsVersion = useConfigurationsVersion();

  useEffect(() => {
    apiClient
      .get<SavedConfig[]>(`/api/configurations?config_type=${configType}`)
      .then((items) => {
        setConfigs(items);
        // If the currently selected config was deleted or renamed away,
        // drop the stale selection so the placeholder is shown again.
        setValue((prev) => (prev && items.some((i) => String(i.id) === prev) ? prev : ''));
      })
      .catch(() => setConfigs([]));
  }, [configType, refreshKey, configsVersion]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const raw = e.target.value;
    setValue(raw);
    const id = Number(raw);
    if (!id) return;
    const c = configs.find((x) => x.id === id);
    if (!c) return;
    const parsed = typeof c.parameters === 'string' ? JSON.parse(c.parameters) : c.parameters;
    onLoad(parsed || {}, c);
  };

  return (
    <div className="form-field">
      <label className="form-label">{label ?? 'Load Configuration'}</label>
      <select className="form-select" value={value} onChange={handleChange}>
        <option value="">— Select a saved configuration —</option>
        {configs.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </div>
  );
};

export default ConfigLoader;
