import type { CliUsageStatus, ModelFlow, ProviderConfig } from '../../../shared/types'
import { CLI_PREFIX, FLOW_PREFIX } from '../../../shared/types'

/** Opções da lista de modelos: um provedor ou um fluxo salvo. */
export function ModelChoiceOptions({
  providers,
  flows,
  agents = [],
  withModel = false
}: {
  providers: Pick<ProviderConfig, 'id' | 'name' | 'model'>[]
  flows: Pick<ModelFlow, 'id' | 'name'>[]
  /** CLIs de agente que respondem no chat. */
  agents?: Pick<CliUsageStatus, 'id' | 'label' | 'installed'>[]
  withModel?: boolean
}): JSX.Element {
  return (
    <>
      {providers.length > 0 && (
        <optgroup label="Modelos">
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {withModel && provider.model ? `${provider.name} · ${provider.model}` : provider.name}
            </option>
          ))}
        </optgroup>
      )}
      {agents.length > 0 && (
        <optgroup label="Agentes deste computador">
          {agents.map((agent) => (
            <option key={agent.id} value={`${CLI_PREFIX}${agent.id}`} disabled={!agent.installed}>
              {agent.installed ? agent.label : `${agent.label} (não instalado)`}
            </option>
          ))}
        </optgroup>
      )}
      {flows.length > 0 && (
        <optgroup label="Fluxos">
          {flows.map((flow) => (
            <option key={flow.id} value={`${FLOW_PREFIX}${flow.id}`}>
              {flow.name.trim() || 'Fluxo sem nome'}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )
}
