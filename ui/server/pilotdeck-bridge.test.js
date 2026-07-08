import { describe, expect, it } from 'vitest';

import { gatewayEventToFrames } from './pilotdeck-bridge.js';

describe('gatewayEventToFrames agent status errors', () => {
    it('uses detail.userHint for model_empty_response_exhausted', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'model_empty_response_exhausted',
            detail: {
                message: 'The model returned empty content repeatedly.',
                userHint: 'Increase max output tokens.',
                visible: true,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'The model returned empty content repeatedly.',
            code: 'model_empty_response_exhausted',
            userHint: 'Increase max output tokens.',
        });
    });

    it('renders new semantic status events as error frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'model_request_failed',
            detail: {
                message: 'Provider rejected the request.',
                userHint: 'Check provider settings.',
                visible: true,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'Provider rejected the request.',
            code: 'model_request_failed',
            userHint: 'Check provider settings.',
        });
    });

    it('renders bridge visible failure status events as error frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'gateway_bridge_error',
            detail: {
                message: 'Bridge crashed while streaming.',
                code: 'gateway_bridge_error',
                severity: 'error',
                visible: true,
                userHint: 'Check UI server logs.',
                scope: 'turn',
                source: 'web_bridge',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'Bridge crashed while streaming.',
            code: 'gateway_bridge_error',
            userHint: 'Check UI server logs.',
        });
    });

    it('renders gateway unavailable preflight status as an error frame', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'gateway_unavailable',
            detail: {
                message: 'PilotDeck gateway is unavailable.',
                code: 'gateway_unavailable',
                severity: 'error',
                visible: true,
                userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
                scope: 'preflight',
                source: 'web_bridge',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'PilotDeck gateway is unavailable.',
            code: 'gateway_unavailable',
            userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
        });
    });
});
