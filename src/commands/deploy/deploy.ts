/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as WebSiteModels from 'azure-arm-website/lib/models';
import { SiteConfigResource } from 'azure-arm-website/lib/models';
import { pathExists } from 'fs-extra';
import * as path from 'path';
import { commands, ConfigurationTarget, Disposable, MessageItem, Uri, window, workspace, WorkspaceFolder } from 'vscode';
import * as appservice from 'vscode-azureappservice';
import { DialogResponses, parseError } from 'vscode-azureextensionui';
import * as constants from '../../constants';
import { SiteTreeItem } from '../../explorer/SiteTreeItem';
import { WebAppTreeItem } from '../../explorer/WebAppTreeItem';
import { ext } from '../../extensionVariables';
import { delay } from '../../utils/delay';
import { nonNullValue } from '../../utils/nonNull';
import { isPathEqual, isSubpath } from '../../utils/pathUtils';
import { getRandomHexString } from "../../utils/randomUtils";
import * as workspaceUtil from '../../utils/workspace';
import { cancelWebsiteValidation, validateWebSite } from '../../validateWebSite';
import { getWorkspaceSetting, updateWorkspaceSetting } from '../../vsCodeConfig/settings';
import { IDeployWizardContext } from '../createWebApp/setAppWizardContextDefault';
import { startStreamingLogs } from '../startStreamingLogs';
import { getDefaultWebAppToDeploy } from './getDefaultWebAppToDeploy';
import { getDeployFsPath } from './getDeployFsPath';
import { setPreDeployTaskForDotnet } from './setPreDeployTaskForDotnet';

// tslint:disable-next-line:max-func-body-length cyclomatic-complexity
export async function deploy(context: IDeployWizardContext, confirmDeployment: boolean, target?: Uri | SiteTreeItem | undefined): Promise<void> {

    let node: SiteTreeItem | undefined;
    const newNodes: SiteTreeItem[] = [];
    context.telemetry.properties.deployedWithConfigs = 'false';
    const fsPath: string = await getDeployFsPath(context, target);

    const currentWorkspace: WorkspaceFolder | undefined = workspaceUtil.getContainingWorkspace(fsPath);
    if (!currentWorkspace) {
        throw new Error('Failed to deploy because the path is not part of an open workspace. Open in a workspace and try again.');
    }

    context.workspace = currentWorkspace;

    if (!node) {
        const onTreeItemCreatedFromQuickPickDisposable: Disposable = ext.tree.onTreeItemCreate((newNode: SiteTreeItem) => {
            // event is fired from azure-extensionui if node was created during deployment
            newNodes.push(newNode);
        });
        try {
            // tslint:disable-next-line: strict-boolean-expressions
            node = await getDefaultWebAppToDeploy(context) || <SiteTreeItem>await ext.tree.showTreeItemPicker(WebAppTreeItem.contextValue, context);
        } catch (err2) {
            if (parseError(err2).isUserCancelledError) {
                context.telemetry.properties.cancelStep = `showTreeItemPicker:${WebAppTreeItem.contextValue}`;
            }
            throw err2;
        } finally {
            onTreeItemCreatedFromQuickPickDisposable.dispose();
        }
    }

    if (newNodes.length > 0) {
        for (const newApp of newNodes) {
            if (newApp.fullId === node.fullId) {
                // if the node selected for deployment is the same newly created nodes, stifle the confirmDeployment dialog
                confirmDeployment = false;
                newApp.root.client.getSiteConfig().then(
                    (createdAppConfig: SiteConfigResource) => {
                        context.telemetry.properties.linuxFxVersion = createdAppConfig.linuxFxVersion ? createdAppConfig.linuxFxVersion : 'undefined';
                        context.telemetry.properties.createdFromDeploy = 'true';
                    },
                    () => {
                        // ignore
                    });
            }
        }
    }

    const correlationId = getRandomHexString();
    context.telemetry.properties.correlationId = correlationId;

    const siteConfig: WebSiteModels.SiteConfigResource = await node.root.client.getSiteConfig();

    // currentWorkspace is only set if there is one active workspace
    // only check enableScmDoBuildDuringDeploy if currentWorkspace matches the workspace being deployed as a user can "Browse" to a different project
    if (getWorkspaceSetting<boolean>(constants.configurationSettings.showBuildDuringDeployPrompt, context.workspace.uri.fsPath)) {
        //check if node is being zipdeployed and that there is no .deployment file in the root folder
        if (siteConfig.linuxFxVersion && siteConfig.scmType === 'None' && !(await pathExists(path.join(currentWorkspace.uri.fsPath, constants.deploymentFileName)))) {
            const linuxFxVersion: string = siteConfig.linuxFxVersion.toLowerCase();
            if (linuxFxVersion.startsWith(appservice.LinuxRuntimes.node)) {
                // if it is node or python, prompt the user (as we can break them)
                await node.promptScmDoBuildDeploy(context.workspace.uri.fsPath, appservice.LinuxRuntimes.node, context);
            } else if (linuxFxVersion.startsWith(appservice.LinuxRuntimes.python)) {
                await node.promptScmDoBuildDeploy(context.workspace.uri.fsPath, appservice.LinuxRuntimes.python, context);
            }

        }
    }

    if (confirmDeployment && siteConfig.scmType !== constants.ScmType.LocalGit && siteConfig !== constants.ScmType.GitHub) {
        const warning: string = `Are you sure you want to deploy to "${node.root.client.fullName}"? This will overwrite any previous deployment and cannot be undone.`;
        context.telemetry.properties.cancelStep = 'confirmDestructiveDeployment';
        const items: MessageItem[] = [constants.AppServiceDialogResponses.deploy];
        const resetDefault: MessageItem = { title: 'Reset default' };
        if (context.deployedWithConfigs) {
            items.push(resetDefault);
        }

        items.push(DialogResponses.cancel);

        // a temporary workaround for this issue: https://github.com/Microsoft/vscode-azureappservice/issues/844
        await delay(500);
        const result: MessageItem = await ext.ui.showWarningMessage(warning, { modal: true }, ...items);
        if (result === resetDefault) {
            if (context.configurationTarget === ConfigurationTarget.Global) {
                await commands.executeCommand('workbench.action.openGlobalSettings');
            } else {
                const localRootPath = context.workspace.uri.fsPath;
                const settingsPath = path.join(localRootPath, '.vscode', 'settings.json');
                const doc = await workspace.openTextDocument(Uri.file(settingsPath));
                window.showTextDocument(doc);
            }

            await updateWorkspaceSetting(constants.configurationSettings.defaultWebAppToDeploy, '', context.workspace.uri.fsPath);

            // If resetDefault button was clicked we ask what and where to deploy again
            await commands.executeCommand('appService.Deploy');
            return;
        }
        context.telemetry.properties.cancelStep = '';
    }

    if (!context.deployedWithConfigs && (isPathEqual(currentWorkspace.uri.fsPath, context.workspace.uri.fsPath) || isSubpath(currentWorkspace.uri.fsPath, context.workspace.uri.fsPath))) {
        // tslint:disable-next-line:no-floating-promises
        node.promptToSaveDeployDefaults(currentWorkspace.uri.fsPath, context);
    }
    if (siteConfig.linuxFxVersion && siteConfig.linuxFxVersion.toLowerCase().includes('dotnet')) {
        await setPreDeployTaskForDotnet(context);
    }

    await appservice.runPreDeployTask(context, context.workspace.uri.fsPath, siteConfig.scmType, constants.extensionPrefix);

    cancelWebsiteValidation(node);
    await node.runWithTemporaryDescription("Deploying...", async () => {
        await appservice.deploy(nonNullValue(node).root.client, <string>context.workspace.uri.fsPath, context, constants.showOutputChannelCommandId);
    });

    const deployComplete: string = `Deployment to "${node.root.client.fullName}" completed.`;
    ext.outputChannel.appendLine(deployComplete);
    const browseWebsite: MessageItem = { title: 'Browse Website' };
    const streamLogs: MessageItem = { title: 'Stream Logs' };

    // Don't wait
    window.showInformationMessage(deployComplete, browseWebsite, streamLogs, constants.AppServiceDialogResponses.viewOutput).then(async (result: MessageItem | undefined) => {
        if (result === constants.AppServiceDialogResponses.viewOutput) {
            ext.outputChannel.show();
        } else if (result === browseWebsite) {
            await nonNullValue(node).browse();
        } else if (result === streamLogs) {
            await startStreamingLogs(context, node);
        }
    });

    // Don't wait
    validateWebSite(correlationId, node).then(
        () => {
            // ignore
        },
        () => {
            // ignore
        });
}