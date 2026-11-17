import type { ModelFlow, ProviderConfig } from '../../../shared/types'
import { FLOW_PREFIX } from '../../../shared/types'

/** Opções da lista de modelos: um provedor ou um fluxo salvo. */
export function ModelChoiceOptions({
  providers,
  flows,
  withModel = false
}: {
  providers: Pick<ProviderConfig, 'id' | 'name' | 'model'>[]
  flows: Pick<ModelFlow, 'id' | 'name'>[]
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
