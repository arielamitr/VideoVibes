import { translate } from '../../../base/i18n/functions';
import { connect } from 'react-redux';
import { Dispatch } from 'redux';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { setVideoVibesMode } from '../../../video-vibes/actions';
import { IconVideoVibesObservation, IconVideoVibesLearning } from '../../../base/icons/svg';


interface IProps extends AbstractButtonProps {
    mode: string;
    dispatch: Dispatch<any>;
}

class VideoVibesButton extends AbstractButton<IProps> {
    accessibilityLabel = 'toolbar.accessibilityLabel.videovibes';

    icon = IconVideoVibesObservation;
    toggledIcon = IconVideoVibesLearning;

    tooltip = 'Toggle between Learning/Observation Mode';

    _handleClick(): void {
        const { dispatch, mode } = this.props;

        const next = mode === 'learning' ? 'observation' : 'learning';
        dispatch(setVideoVibesMode(next));
    }

    _isToggled(): boolean {
        return this.props.mode === 'learning';
    }

    _getLabel() {
        return this.props.mode === 'learning'
            ? 'toolbar.videovibes.learning'
            : 'toolbar.videovibes.observation';
    }

    _getTooltip() {
        return this.props.mode === 'learning'
            ? 'Learning Mode (click to switch to Observation)'
            : 'Observation Mode (click to switch to Learning)';
    }
}


function _mapStateToProps(state: any) {
    const vvState = state['features/video-vibes'];
    return {
        mode: vvState?.mode || 'observation'
    };
}

export default translate(connect(_mapStateToProps)(VideoVibesButton));
