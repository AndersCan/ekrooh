import { describe, expect, it } from 'vite-plus/test';
import { discoveryEvents, discoverySpecs } from './events';

describe('discoveryEvents builders', () => {
  it('list builds the discovery invoke envelope', () => {
    expect(discoveryEvents.discovery.list()).toMatchObject({
      kind: 'invoke',
      pluginId: 'core.discovery',
      event: 'discovery.list',
      args: {},
    });
  });

  it('specs pin the wire event name', () => {
    expect(discoverySpecs.list.name).toBe('discovery.list');
    expect(discoverySpecs.list.pluginId).toBe('core.discovery');
  });
});
