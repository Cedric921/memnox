import type { FilesRequestFields, FilesResponseFields } from './files';
import type { HomeResponseFields } from './home';
import type { InterceptRequestFields, InterceptResponseFields } from './intercept';
import type {
  RemoteEventFields,
  RemoteRequestFields,
  RemoteResponseFields,
} from './remote';
import type { SpeechRequestFields, SpeechResponseFields } from './speech';
import type { TeamAnswerBrief, TeamCallBrief } from './team-calls';

/**
 * The fields each part of the protocol adds, gathered in one place so the core protocol reads as
 * its own few methods and a new part is one line here rather than a longer list there.
 */

interface TeamRequestFields {
  /** On ASK from a device signed in to its team: the team's questions waiting on the person. */
  teamCalls?: TeamCallBrief[];
}

interface TeamEventFields {
  /** On a PROPOSAL answering a team's question, which the device carries out with the workspace. */
  teamAnswer?: TeamAnswerBrief;
}

export interface ExtensionRequestFields
  extends
    RemoteRequestFields,
    FilesRequestFields,
    SpeechRequestFields,
    TeamRequestFields,
    InterceptRequestFields {}

export interface ExtensionResponseFields
  extends
    RemoteResponseFields,
    FilesResponseFields,
    SpeechResponseFields,
    HomeResponseFields,
    InterceptResponseFields {}

export interface ExtensionEventFields extends RemoteEventFields, TeamEventFields {}
