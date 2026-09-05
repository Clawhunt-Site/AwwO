import type { Ref } from 'react';
import { API_KEY_PLACEHOLDERS } from '../../state/apiProtocols';
import type { ApiProtocol, ConnectionTestResponse } from '../../types';
import { Icon } from '../Icon';

type ByokProviderTestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: ConnectionTestResponse };

interface ByokKeyFieldProps {
  apiKey: string;
  apiKeyAuthFailed: boolean;
  apiKeyConsoleLink: { host: string; url: string };
  apiProtocol: ApiProtocol;
  baseUrlValid: boolean;
  canRunConnectionTest: boolean;
  inputRef: Ref<HTMLInputElement>;
  labels: {
    apiHint: string;
    apiKey: string;
    apiKeyGetLink: string;
    apiKeyInvalid: string;
    hide: string;
    hideKey: string;
    required: string;
    show: string;
    showKey: string;
    test: string;
    testRetry: string;
    testRunning: string;
    testTitle: string;
  };
  providerTestState: ByokProviderTestState;
  renderTestMessage: (result: ConnectionTestResponse) => string;
  requiresApiKey: boolean;
  showApiKey: boolean;
  onBlur: () => void;
  onChange: (value: string) => void;
  onFocus: () => void;
  onTestProvider: () => void | Promise<void>;
  onToggleShowApiKey: () => void;
}

export function ByokKeyField({
  apiKey,
  apiKeyAuthFailed,
  apiKeyConsoleLink,
  apiProtocol,
  baseUrlValid,
  canRunConnectionTest,
  inputRef,
  labels,
  providerTestState,
  renderTestMessage,
  requiresApiKey,
  showApiKey,
  onBlur,
  onChange,
  onFocus,
  onTestProvider,
  onToggleShowApiKey,
}: ByokKeyFieldProps) {
  return (
    <label className="field">
      <span className="field-label-row">
        <span className="field-label">
          {labels.apiKey}
          {requiresApiKey ? (
            <span className="field-required" aria-label={labels.required}>
              *
            </span>
          ) : null}
        </span>
        {requiresApiKey ? (
          <a
            className="field-label-link"
            href={apiKeyConsoleLink.url}
            target="_blank"
            rel="noreferrer"
          >
            {labels.apiKeyGetLink}
          </a>
        ) : null}
      </span>
      <div className="field-row">
        <input
          ref={inputRef}
          aria-label={labels.apiKey}
          type={showApiKey ? 'text' : 'password'}
          placeholder={API_KEY_PLACEHOLDERS[apiProtocol]}
          value={apiKey}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onFocus={onFocus}
          autoFocus
        />
        <button
          type="button"
          className="ghost icon-btn"
          onClick={onToggleShowApiKey}
          title={
            showApiKey ? labels.hideKey : labels.showKey
          }
        >
          {showApiKey ? labels.hide : labels.show}
        </button>
      </div>
      {apiKeyAuthFailed && providerTestState.status === 'idle' ? (
        <span className="field-error" role="alert">
          {labels.apiKeyInvalid}
        </span>
      ) : null}
      {providerTestState.status === 'running' ? (
        <span
          className="field-inline-status running"
          role="status"
          aria-live="polite"
        >
          {labels.testRunning}
        </span>
      ) : providerTestState.status === 'done' ? (
        <span
          className={
            providerTestState.result.ok
              ? 'field-inline-status success'
              : 'field-error'
          }
          role={providerTestState.result.ok ? 'status' : 'alert'}
        >
          {renderTestMessage(providerTestState.result)}
        </span>
      ) : null}
      <span className="field-inline-status">
        {labels.apiHint}
      </span>
      {canRunConnectionTest && baseUrlValid ? (
        <button
          type="button"
          className={
            'ghost icon-btn settings-test-btn' +
            (providerTestState.status === 'running' ? ' loading' : '')
          }
          onClick={() => void onTestProvider()}
          disabled={providerTestState.status === 'running'}
          title={labels.testTitle}
        >
          {providerTestState.status === 'running' ? (
            <>
              <Icon
                name="spinner"
                size={13}
                className="icon-spin"
              />
              <span>{labels.test}</span>
            </>
          ) : providerTestState.status === 'done' &&
            !providerTestState.result.ok ? (
            <>
              <Icon name="reload" size={13} />
              <span>{labels.testRetry}</span>
            </>
          ) : (
            labels.test
          )}
        </button>
      ) : null}
    </label>
  );
}
