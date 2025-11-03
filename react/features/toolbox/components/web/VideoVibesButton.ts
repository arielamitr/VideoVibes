import { translate } from '../../../base/i18n/functions';
import { connect } from 'react-redux';                       // ← use react-redux here
import { IReduxState } from '../../../app/types';
import { getJitsiMeetGlobalNS } from '../../../base/util/helpers';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';

class VideoVibesButton extends AbstractButton<AbstractButtonProps> {
    accessibilityLabel = 'toolbar.accessibilityLabel.videovibes';
    icon = 'icon-recording';
    label = 'toolbar.videovibes';
    tooltip = 'toolbar.videovibes';

    _handleClick(): void {
        const api = (getJitsiMeetGlobalNS() as any)?.videovibes;
        api?.toggle?.();
    }

    _isToggled(): boolean {
        const api = (getJitsiMeetGlobalNS() as any)?.videovibes;
        return api?.getMode?.() === 'learning';
    }
}

function _mapStateToProps(_state: IReduxState) {
    return {};
}

export default translate(connect(_mapStateToProps)(VideoVibesButton));
