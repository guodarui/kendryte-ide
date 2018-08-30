import { Action } from 'vs/base/common/actions';
import { TPromise } from 'vs/base/common/winjs.base';
import { localize } from 'vs/nls';
import { ACTION_ID_MAIX_CMAKE_CLEANUP, CMAKE_CHANNEL, ICMakeService } from 'vs/workbench/parts/maix/cmake/common/type';
import { IOutputChannel, IOutputService } from 'vs/workbench/parts/output/common/output';

export class MaixCMakeCleanupAction extends Action {
	public static readonly ID = ACTION_ID_MAIX_CMAKE_CLEANUP;
	public static readonly LABEL = localize('Cleanup', 'Cleanup');
	protected outputChannel: IOutputChannel;

	constructor(
		id = MaixCMakeCleanupAction.ID, label = MaixCMakeCleanupAction.LABEL,
		@ICMakeService protected cmakeService: ICMakeService,
		@IOutputService protected outputService: IOutputService,
	) {
		super(id, label);
		this.outputChannel = outputService.getChannel(CMAKE_CHANNEL);
	}

	async run(): TPromise<void> {
		this.outputChannel.clear();
		this.outputService.showChannel(CMAKE_CHANNEL, true);

		await this.cmakeService.cleanupMake();
	}
}