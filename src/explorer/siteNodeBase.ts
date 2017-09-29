/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as WebSiteModels from '../../node_modules/azure-arm-website/lib/models';
import * as opn from 'opn';
import * as path from 'path';
import * as util from '../util';
import WebSiteManagementClient = require('azure-arm-website');
import { NodeBase } from './nodeBase';
import { AppSettingsNode } from './appSettingsNodes';
import { AppServiceDataProvider } from './appServiceExplorer';
import { SubscriptionModels } from 'azure-arm-resource';
import { ExtensionContext, TreeDataProvider, TreeItem, OutputChannel, window, workspace } from 'vscode';
import { AzureAccountWrapper } from '../azureAccountWrapper';
import { KuduClient } from '../kuduClient';
import { Request } from 'request';

export class SiteNodeBase extends NodeBase {
    private _logStreamOutputChannel: OutputChannel;
    private _logStream: Request;

    constructor(readonly label: string,
        readonly site: WebSiteModels.Site,
        readonly subscription: SubscriptionModels.Subscription,
        treeDataProvider: AppServiceDataProvider,
        parentNode: NodeBase) {
        super(label, treeDataProvider, parentNode);
    }

    protected get azureAccount(): AzureAccountWrapper {
        return this.getTreeDataProvider<AppServiceDataProvider>().azureAccount;
    }

    browse(): void {
        const defaultHostName = this.site.defaultHostName;
        const isSsl = this.site.hostNameSslStates.findIndex((value, index, arr) =>
            value.name === defaultHostName && value.sslState === "Enabled");
        const uri = `${isSsl ? 'https://' : 'http://'}${defaultHostName}`;
        opn(uri);
    }

    openInPortal(): void {
        const portalEndpoint = 'https://portal.azure.com';
        const deepLink = `${portalEndpoint}/${this.subscription.tenantId}/#resource${this.site.id}`;
        opn(deepLink);
    }

    async connectToLogStream(extensionContext: ExtensionContext): Promise<void> {
        const siteName = util.extractSiteName(this.site) + (util.isSiteDeploymentSlot(this.site) ? '-' + util.extractDeploymentSlotName(this.site) : '');
        const user = await util.getWebAppPublishCredential(this.webSiteClient, this.site);
        const kuduClient = new KuduClient(siteName, user.publishingUserName, user.publishingPassword);

        if (!this._logStreamOutputChannel) {
            this._logStreamOutputChannel = window.createOutputChannel(`${siteName} - Log Stream`);
            extensionContext.subscriptions.push(this._logStreamOutputChannel);
        }

        this._logStreamOutputChannel.appendLine('Connecting to log-streaming service...')
        this._logStreamOutputChannel.show();

        this.stopLogStream();

        this._logStream = kuduClient.getLogStream().on('data', chunk => {
            this._logStreamOutputChannel.append(chunk.toString());
        }).on('error', err => {
            util.sendTelemetry('ConnectToLogStreamError', { name: err.name, message: err.message });
            this._logStreamOutputChannel.appendLine('Error connecting to log-streaming service:');
            this._logStreamOutputChannel.appendLine(err.message);
        }).on('complete', (resp, body) => {
            this._logStreamOutputChannel.appendLine('Disconnected from log-streaming service.');
        });
    }

    stopLogStream(): void {
        if (this._logStream) {
            this._logStream.removeAllListeners();
            this._logStream.destroy();
            this._logStream = null;

            if (this._logStreamOutputChannel) {
                this._logStreamOutputChannel.appendLine('Disconnected from log-streaming service.');
            }
        }
    }

    async localGitDeploy(): Promise<boolean> {
        const publishCredentials = !util.isSiteDeploymentSlot(this.site) ?
            await this.webSiteClient.webApps.listPublishingCredentials(this.site.resourceGroup, this.site.name) :
            await this.webSiteClient.webApps.listPublishingCredentialsSlot(this.site.resourceGroup, util.extractSiteName(this.site), util.extractDeploymentSlotName(this.site));
        const config = !util.isSiteDeploymentSlot(this.site) ?
            await this.webSiteClient.webApps.getConfiguration(this.site.resourceGroup, this.site.name) :
            await this.webSiteClient.webApps.getConfigurationSlot(this.site.resourceGroup, util.extractSiteName(this.site), util.extractDeploymentSlotName(this.site));
        const oldDeployment = !util.isSiteDeploymentSlot(this.site) ?
            await this.webSiteClient.webApps.listDeployments(this.site.resourceGroup, this.site.name) :
            await this.webSiteClient.webApps.listDeploymentsSlot(this.site.resourceGroup, util.extractSiteName(this.site), util.extractDeploymentSlotName(this.site));

        if (config.scmType !== 'LocalGit') {
            let input = await window.showErrorMessage(`Local Git Deployment is not set up. Set it up in the Azure Portal.`, `Go to Portal`)
            if (input === 'Go to Portal') {
                this.openInPortal();
            }
            throw new Error(`Local Git Deployment is not set up. Set it up in the Azure Portal.`);
        }

        const username = publishCredentials.publishingUserName;
        const password = publishCredentials.publishingPassword;
        const repo = `${this.site.enabledHostNames[1]}:443/${this.site.repositorySiteName}.git`;
        const remote = `https://${username}:${password}@${repo}`;

        if (!workspace.rootPath) {
            let input = await window.showErrorMessage(`You have not yet opened a folder to deploy.`);
            return;
        }
        let git = require('simple-git/promise')(workspace.rootPath);

        try {
            await git.init();
            await git.push(remote, 'master');
        }
        catch (err) {
            if (err.message.indexOf('spawn git ENOENT') >= 0) {
                let input = await window.showErrorMessage(`Git must be installed to use Local Git Deploy.`, `Install`)
                if (input === 'Install') {
                    opn(`https://git-scm.com/downloads`);
                }
                throw err;
            } else if (err.message.indexOf('error: failed to push') >= 0) {
                let input = await window.showErrorMessage(`Push rejected due to Git history diverging. Force push?`, `Yes`)
                if (input === 'Yes') {
                    await git.push(['-f', remote, 'master']);
                } else {
                    throw err;
                }
            } else {
                throw err;
            }
        }

        const newDeployment = !util.isSiteDeploymentSlot(this.site) ?
            await this.webSiteClient.webApps.listDeployments(this.site.resourceGroup, this.site.name) :
            await this.webSiteClient.webApps.listDeploymentsSlot(this.site.resourceGroup, util.extractSiteName(this.site), util.extractDeploymentSlotName(this.site));

        if (newDeployment[0].deploymentId === oldDeployment[0].deploymentId) {
            await window.showWarningMessage(`Local Git repo is current with "${repo}".`);
            throw new Error(`Local Git repo is current with "${repo}".`);
        }
        return true;

    }

    protected get webSiteClient(): WebSiteManagementClient {
        return new WebSiteManagementClient(this.azureAccount.getCredentialByTenantId(this.subscription.tenantId), this.subscription.subscriptionId);
    }
}