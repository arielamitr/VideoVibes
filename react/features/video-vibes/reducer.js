import ReducerRegistry from '../base/redux/ReducerRegistry';

export const SET_VIDEOVIBES_MODE = 'SET_VIDEOVIBES_MODE';

const DEFAULT_STATE = {
    mode: 'observation'
};

ReducerRegistry.register('features/video-vibes', (state = DEFAULT_STATE, action) => {
    switch (action.type) {
    case SET_VIDEOVIBES_MODE:
        return {
            ...state,
            mode: action.mode
        };

    default:
        return state;
    }
});
